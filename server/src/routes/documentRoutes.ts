import { Router, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { DocumentModel } from '../models/Document.js';
import { User } from '../models/User.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { revokeUserFromRoom, broadcastDocumentRename } from '../sockets/socketHandler.js';

export const documentRouter = Router();

// All document routes require authentication
documentRouter.use(requireAuth);

// Schemas
const createDocSchema = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').max(120).default('Untitled Document'),
});

const renameDocSchema = z.object({
  title: z.string().trim().min(1, 'Title cannot be empty').max(120),
});

const addCollaboratorSchema = z.object({
  email: z.string().trim().email('Invalid email address').toLowerCase(),
});

// Helper to check valid ObjectId
function isValidObjectId(id: string | string[] | undefined): id is string {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

// 1. Create document
documentRouter.post(
  '/',
  validateBody(createDocSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { title } = req.body;
      const userId = req.user!.id;

      const doc = await DocumentModel.create({
        title,
        owner: userId,
        collaborators: [],
      });

      const populatedDoc = await DocumentModel.findById(doc._id)
        .populate('owner', 'name email')
        .populate('collaborators', 'name email');

      res.status(201).json({
        success: true,
        data: {
          document: populatedDoc,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// 2. List documents accessible to current user (as owner or collaborator)
documentRouter.get(
  '/',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = new mongoose.Types.ObjectId(req.user!.id);

      const documents = await DocumentModel.find({
        $or: [{ owner: userId }, { collaborators: userId }],
      })
        .sort({ updatedAt: -1 })
        .populate('owner', 'name email')
        .populate('collaborators', 'name email');

      res.status(200).json({
        success: true,
        data: {
          documents,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// 3. Get document metadata
documentRouter.get(
  '/:id',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      if (!isValidObjectId(id)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_ID', message: 'Invalid document ID format' },
        });
        return;
      }

      const doc = await DocumentModel.findById(id)
        .populate('owner', 'name email')
        .populate('collaborators', 'name email');

      if (!doc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const userId = req.user!.id;
      const isOwner = (doc.owner as any)._id?.toString() === userId || doc.owner.toString() === userId;
      const isCollaborator = doc.collaborators.some(
        (c: any) => (c._id?.toString() || c.toString()) === userId
      );

      if (!isOwner && !isCollaborator) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'You are not authorized to access this document' },
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          document: doc,
          isOwner,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// 4. Rename document
documentRouter.patch(
  '/:id',
  validateBody(renameDocSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const { title } = req.body;

      if (!isValidObjectId(id)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_ID', message: 'Invalid document ID format' },
        });
        return;
      }

      const doc = await DocumentModel.findById(id);
      if (!doc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const userId = req.user!.id;
      const isOwner = doc.owner.toString() === userId;
      const isCollaborator = doc.collaborators.some((c) => c.toString() === userId);

      if (!isOwner && !isCollaborator) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'You do not have permission to rename this document' },
        });
        return;
      }

      doc.title = title;
      await doc.save();

      // Broadcast title rename to all active collaborators in the room
      broadcastDocumentRename(id, title);

      const updatedDoc = await DocumentModel.findById(id)
        .populate('owner', 'name email')
        .populate('collaborators', 'name email');

      res.status(200).json({
        success: true,
        data: {
          document: updatedDoc,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// 5. Add collaborator by email (Owner only)
documentRouter.post(
  '/:id/collaborators',
  validateBody(addCollaboratorSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const { email } = req.body;

      if (!isValidObjectId(id)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_ID', message: 'Invalid document ID format' },
        });
        return;
      }

      const doc = await DocumentModel.findById(id);
      if (!doc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const currentUserId = req.user!.id;
      if (doc.owner.toString() !== currentUserId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Only the document owner can invite collaborators' },
        });
        return;
      }

      const targetUser = await User.findOne({ email });
      if (!targetUser) {
        res.status(404).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: `No registered user found with email ${email}` },
        });
        return;
      }

      const targetUserId = targetUser._id.toString();
      if (targetUserId === currentUserId) {
        res.status(400).json({
          success: false,
          error: { code: 'ALREADY_OWNER', message: 'The owner already has full access to this document' },
        });
        return;
      }

      const alreadyCollaborator = doc.collaborators.some((c) => c.toString() === targetUserId);
      if (alreadyCollaborator) {
        res.status(409).json({
          success: false,
          error: { code: 'ALREADY_COLLABORATOR', message: 'User is already a collaborator on this document' },
        });
        return;
      }

      doc.collaborators.push(targetUser._id);
      await doc.save();

      const updatedDoc = await DocumentModel.findById(id)
        .populate('owner', 'name email')
        .populate('collaborators', 'name email');

      res.status(200).json({
        success: true,
        data: {
          document: updatedDoc,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// 6. Remove collaborator (Owner or self)
documentRouter.delete(
  '/:id/collaborators/:userId',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id, userId } = req.params;

      if (!isValidObjectId(id) || !isValidObjectId(userId)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_ID', message: 'Invalid ID format' },
        });
        return;
      }

      const doc = await DocumentModel.findById(id);
      if (!doc) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const currentUserId = req.user!.id;
      const isOwner = doc.owner.toString() === currentUserId;
      const isSelf = currentUserId === userId;

      if (!isOwner && !isSelf) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'You do not have permission to remove this collaborator' },
        });
        return;
      }

      doc.collaborators = doc.collaborators.filter((c) => c.toString() !== userId);
      await doc.save();

      // Immediately evict active socket connections for the revoked collaborator
      revokeUserFromRoom(id, userId);

      const updatedDoc = await DocumentModel.findById(id)
        .populate('owner', 'name email')
        .populate('collaborators', 'name email');

      res.status(200).json({
        success: true,
        data: {
          document: updatedDoc,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

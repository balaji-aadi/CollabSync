import { Server as SocketIOServer, Socket } from 'socket.io';
import mongoose from 'mongoose';
import * as Y from 'yjs';
import {
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { DocumentModel } from '../models/Document.js';
import { verifyAuthToken, AuthUser } from '../middleware/auth.js';
import { roomManager } from './roomManager.js';
import { env } from '../config/env.js';

export interface AuthenticatedSocket extends Socket {
  data: {
    user: AuthUser;
    revokedRooms?: Map<string, number>;
  };
}

/**
 * Deterministic user color generation for awareness cursors
 */
const USER_COLORS = [
  '#f43f5e', // rose
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#3b82f6', // blue
  '#14b8a6', // teal
];

export function getUserColor(userId?: string): string {
  if (!userId) return USER_COLORS[0];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

/**
 * Sanitize and validate incoming awareness binary updates.
 * - Enforces authenticated server-side user identity (id, name, deterministic color)
 * - Strips sensitive fields (email, tokens, passwords)
 * - Validates client IDs to prevent client ID spoofing/hijacking across sockets
 */
export function sanitizeAwarenessUpdate(
  docId: string,
  socketId: string,
  user: AuthUser,
  update: Uint8Array
): { sanitized: Uint8Array; clientIDs: number[] } | null {
  try {
    const decoder = decoding.createDecoder(update);
    const encoder = encoding.createEncoder();
    const len = decoding.readVarUint(decoder);

    const rawEntries: { clientID: number; clock: number; str: string }[] = [];
    const candidateClientIDs: number[] = [];

    for (let i = 0; i < len; i++) {
      const clientID = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const str = decoding.readVarString(decoder);
      rawEntries.push({ clientID, clock, str });
      candidateClientIDs.push(clientID);
    }

    const acceptedClientIDs = roomManager.registerSocketAwareness(
      docId,
      socketId,
      candidateClientIDs
    );
    const acceptedSet = new Set(acceptedClientIDs);
    const acceptedEntries: { clientID: number; clock: number; str: string }[] = [];

    for (const entry of rawEntries) {
      if (!acceptedSet.has(entry.clientID)) {
        continue;
      }

      let modifiedStr = entry.str;
      if (entry.str !== 'null') {
        try {
          const state = JSON.parse(entry.str);
          if (typeof state === 'object' && state !== null) {
            state.user = {
              id: user.id,
              name: user.name,
              color: getUserColor(user.id),
            };
            delete state.email;
            delete state.token;
            delete state.password;
            delete state.role;
            modifiedStr = JSON.stringify(state);
          }
        } catch {
          continue;
        }
      }

      acceptedEntries.push({
        clientID: entry.clientID,
        clock: entry.clock,
        str: modifiedStr,
      });
    }

    if (acceptedEntries.length === 0) {
      return null;
    }

    encoding.writeVarUint(encoder, acceptedEntries.length);
    for (const entry of acceptedEntries) {
      encoding.writeVarUint(encoder, entry.clientID);
      encoding.writeVarUint(encoder, entry.clock);
      encoding.writeVarString(encoder, entry.str);
    }

    return {
      sanitized: encoding.toUint8Array(encoder),
      clientIDs: acceptedEntries.map((e) => e.clientID),
    };
  } catch (err) {
    return null;
  }
}

/**
 * Parse a named cookie value from raw Cookie header string
 */
function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const matches = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return matches ? decodeURIComponent(matches[1]) : undefined;
}

let activeIO: SocketIOServer | null = null;

export function getActiveIO(): SocketIOServer | null {
  return activeIO;
}

/**
 * Safely evict awareness states for a socket and broadcast the removal update to room peers.
 */
function evictSocketAwareness(
  docId: string,
  socketId: string,
  broadcastFn: (update: Uint8Array) => void
): void {
  const evictedClients = roomManager.removeSocketAwareness(docId, socketId);
  if (evictedClients.length === 0) return;

  const room = roomManager.getRoom(docId);
  if (!room) return;

  // Filter clients to those actually registered in awareness.meta to prevent clock lookup TypeError
  const validClients = evictedClients.filter((cid) => room.awareness.meta.has(cid));
  if (validClients.length === 0) return;

  removeAwarenessStates(room.awareness, validClients, socketId);
  const removalUpdate = encodeAwarenessUpdate(room.awareness, validClients);
  broadcastFn(removalUpdate);
}

/**
 * Revoke a user's access to an active document room across all their active sockets.
 */
export function revokeUserFromRoom(docId: string, userId: string): void {
  if (!activeIO) return;

  const sockets = activeIO.sockets.sockets;
  for (const socket of sockets.values()) {
    const authSocket = socket as AuthenticatedSocket;
    if (authSocket.data?.user?.id === userId) {
      if (!authSocket.data.revokedRooms) {
        authSocket.data.revokedRooms = new Map();
      }
      authSocket.data.revokedRooms.set(docId, Date.now());

      const wasInRoom = authSocket.rooms.has(docId);

      // Clean up and immediately broadcast awareness eviction for this socket
      evictSocketAwareness(docId, authSocket.id, (update) => {
        activeIO!.to(docId).emit('awareness-update', {
          docId,
          update: Buffer.from(update),
        });
      });

      authSocket.leave(docId);
      roomManager.removeSocket(docId, authSocket.id);

      authSocket.emit('document-error', {
        code: 'ACCESS_REVOKED',
        message: 'Your access to this document has been revoked by the owner.',
      });

      if (wasInRoom) {
        activeIO.to(docId).emit('user-left', {
          docId,
          user: { id: authSocket.data.user.id, name: authSocket.data.user.name },
        });
      }

      if (env.NODE_ENV !== 'test') {
        console.log(`[Socket] Evicted revoked user ${userId} from room ${docId}`);
      }
    }
  }
}

/**
 * Broadcast document rename to all active clients in the document room.
 */
export function broadcastDocumentRename(docId: string, title: string): void {
  if (!activeIO) return;
  activeIO.to(docId).emit('document-renamed', { docId, title });
}

export function registerSocketHandlers(io: SocketIOServer): void {
  activeIO = io;

  // Listen for RoomManager persistence events and broadcast save status to room members
  roomManager.onSaveStatus((docId, status, lastSavedAt, errorMsg) => {
    if (activeIO) {
      activeIO.to(docId).emit('save-status', {
        docId,
        status,
        lastSavedAt: lastSavedAt ? lastSavedAt.toISOString() : undefined,
        error: errorMsg,
      });
    }
  });

  // Authentication middleware for Socket.IO connections
  io.use((socket, next) => {
    let token = socket.handshake.auth?.token;

    // Fall back to HTTP-only cookie if no auth.token passed
    if (!token && socket.request.headers.cookie) {
      token = parseCookie(socket.request.headers.cookie, env.COOKIE_NAME);
    }

    if (!token) {
      return next(new Error('UNAUTHORIZED: No authentication token provided'));
    }

    try {
      const user = verifyAuthToken(token);
      socket.data.user = user;
      socket.data.revokedRooms = new Map();
      next();
    } catch (err: any) {
      return next(new Error('UNAUTHORIZED: Invalid or expired token'));
    }
  });

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as AuthenticatedSocket;
    const user = socket.data.user;

    if (env.NODE_ENV !== 'test') {
      console.log(`[Socket] User connected: ${user.name} (${user.id}) [socket: ${socket.id}]`);
    }

    // Join a document editing room
    socket.on('join-document', async (payload: { docId: string; stateVector?: any }, callback?: (res: any) => void) => {
      const joinTimestamp = Date.now();
      try {
        const { docId, stateVector } = payload || {};
        if (!docId || !mongoose.Types.ObjectId.isValid(docId)) {
          socket.emit('document-error', { code: 'INVALID_ID', message: 'Invalid document ID' });
          if (callback) callback({ success: false, error: 'Invalid document ID' });
          return;
        }

        // Initialize room from MongoDB if not already in memory
        const room = await roomManager.initializeRoom(docId);

        // Verify document authorization against database
        const doc = await DocumentModel.findById(docId);
        if (!doc) {
          socket.emit('document-error', { code: 'NOT_FOUND', message: 'Document not found' });
          if (callback) callback({ success: false, error: 'Document not found' });
          return;
        }

        const isOwner = doc.owner.toString() === user.id;
        const isCollaborator = doc.collaborators.some((c) => c.toString() === user.id);

        if (!isOwner && !isCollaborator) {
          socket.emit('document-error', {
            code: 'FORBIDDEN',
            message: 'You are not authorized to access this document room',
          });
          if (callback) callback({ success: false, error: 'Forbidden' });
          return;
        }

        // Guard against race where collaborator was revoked while room was initializing
        const lastRevoked = socket.data.revokedRooms?.get(docId);
        if (lastRevoked && lastRevoked >= joinTimestamp) {
          socket.emit('document-error', {
            code: 'ACCESS_REVOKED',
            message: 'Your access to this document has been revoked by the owner.',
          });
          if (callback) callback({ success: false, error: 'Access revoked' });
          return;
        }

        // Add socket to Socket.IO room & RoomManager
        socket.join(docId);
        roomManager.addSocket(docId, socket.id);

        // If client provided state vector for differential sync, send only missing diff
        if (stateVector) {
          const clientVector = Buffer.isBuffer(stateVector)
            ? new Uint8Array(stateVector)
            : Array.isArray(stateVector)
            ? new Uint8Array(stateVector)
            : new Uint8Array(Object.values(stateVector));

          const diff = Y.encodeStateAsUpdate(room.ydoc, clientVector);
          socket.emit('sync-step-2', {
            docId,
            update: Buffer.from(diff),
          });
        }

        // Send compiled current state for backward compatibility and initial load
        const currentState = Y.encodeStateAsUpdate(room.ydoc);
        socket.emit('initial-state', {
          docId,
          update: Buffer.from(currentState),
        });

        // Send server state vector so client can compute missing local edits (Sync Step 1)
        socket.emit('sync-step-1', {
          docId,
          stateVector: Buffer.from(Y.encodeStateVector(room.ydoc)),
        });

        // Send current persistence save status
        socket.emit('save-status', {
          docId,
          status: room.dirty ? 'saving' : 'saved',
          lastSavedAt: room.lastSavedAt ? room.lastSavedAt.toISOString() : undefined,
        });

        // Send existing active awareness states in this room to the new peer
        const activeClientIds = Array.from(room.awareness.getStates().keys());
        if (activeClientIds.length > 0) {
          const activeAwareness = encodeAwarenessUpdate(room.awareness, activeClientIds);
          if (activeAwareness.length > 0) {
            socket.emit('awareness-update', {
              docId,
              update: Buffer.from(activeAwareness),
            });
          }
        }

        // Broadcast presence without leaking sensitive user email
        socket.to(docId).emit('user-joined', {
          docId,
          user: { id: user.id, name: user.name },
        });

        if (callback) callback({ success: true });
      } catch (error: any) {
        socket.emit('document-error', { code: 'SERVER_ERROR', message: error.message });
        if (callback) callback({ success: false, error: error.message });
      }
    });

    // Handle Yjs Sync Step 1 (Peer sends its state vector to request diff)
    socket.on('sync-step-1', (payload: { docId: string; stateVector: any }) => {
      const { docId, stateVector } = payload || {};
      if (!docId || !stateVector || !socket.rooms.has(docId) || !roomManager.hasSocket(docId, socket.id)) return;

      try {
        const room = roomManager.getOrCreateRoom(docId);
        const vector = Buffer.isBuffer(stateVector)
          ? new Uint8Array(stateVector)
          : Array.isArray(stateVector)
          ? new Uint8Array(stateVector)
          : new Uint8Array(Object.values(stateVector));

        const diff = Y.encodeStateAsUpdate(room.ydoc, vector);
        socket.emit('sync-step-2', {
          docId,
          update: Buffer.from(diff),
        });
      } catch (err: any) {
        if (env.NODE_ENV !== 'test') {
          console.warn(`[Socket] Ignored invalid sync-step-1 from ${socket.id}:`, err.message);
        }
      }
    });

    // Handle Yjs Sync Step 2 (Peer contributes its missing diff)
    socket.on('sync-step-2', (payload: { docId: string; update: any }) => {
      const { docId, update } = payload || {};
      if (!docId || !update || !socket.rooms.has(docId) || !roomManager.hasSocket(docId, socket.id)) return;

      try {
        const binaryUpdate = Buffer.isBuffer(update)
          ? new Uint8Array(update)
          : Array.isArray(update)
          ? new Uint8Array(update)
          : new Uint8Array(Object.values(update));

        if (binaryUpdate.length > 0) {
          roomManager.applyUpdate(docId, binaryUpdate, socket.id);
          socket.to(docId).emit('document-update', {
            docId,
            update: Buffer.from(binaryUpdate),
          });
        }
      } catch (err: any) {
        if (env.NODE_ENV !== 'test') {
          console.warn(`[Socket] Ignored invalid sync-step-2 from ${socket.id}:`, err.message);
        }
      }
    });

    // Handle real-time CRDT updates
    socket.on('document-update', (payload: { docId: string; update: any }, callback?: (res: any) => void) => {
      const { docId, update } = payload || {};
      if (!docId || !update || !socket.rooms.has(docId) || !roomManager.hasSocket(docId, socket.id)) {
        if (callback) callback({ success: false, error: 'Unauthorized or invalid payload' });
        return;
      }

      try {
        const binaryUpdate = Buffer.isBuffer(update)
          ? new Uint8Array(update)
          : Array.isArray(update)
          ? new Uint8Array(update)
          : new Uint8Array(Object.values(update));

        // Apply to server in-memory Y.Doc and schedule debounced persistence
        roomManager.applyUpdate(docId, binaryUpdate, socket.id);

        // Broadcast to all other peers in the room
        socket.to(docId).emit('document-update', {
          docId,
          update: Buffer.from(binaryUpdate),
        });

        if (callback) callback({ success: true });
      } catch (err: any) {
        if (env.NODE_ENV !== 'test') {
          console.warn(`[Socket] Ignored invalid CRDT update for room ${docId}:`, err.message);
        }
        if (callback) callback({ success: false, error: err.message });
      }
    });

    // Handle ephemeral live awareness and cursor updates
    socket.on('awareness-update', (payload: { docId: string; update: any }) => {
      const { docId, update } = payload || {};
      if (!docId || !update || !socket.rooms.has(docId) || !roomManager.hasSocket(docId, socket.id)) return;

      try {
        const binaryUpdate = Buffer.isBuffer(update)
          ? new Uint8Array(update)
          : Array.isArray(update)
          ? new Uint8Array(update)
          : new Uint8Array(Object.values(update));

        const room = roomManager.getRoom(docId);
        if (!room) return;

        const sanitized = sanitizeAwarenessUpdate(docId, socket.id, user, binaryUpdate);
        if (!sanitized) return;

        applyAwarenessUpdate(room.awareness, sanitized.sanitized, socket.id);

        // Relay sanitized update to other peers in room without echoing
        socket.to(docId).emit('awareness-update', {
          docId,
          update: Buffer.from(sanitized.sanitized),
        });
      } catch (err: any) {
        if (env.NODE_ENV !== 'test') {
          console.warn(`[Socket] Error relaying awareness update for ${docId}:`, err.message);
        }
      }
    });

    // Handle manual save / retry request
    socket.on('flush-document', async (payload: { docId: string }, callback?: (res: any) => void) => {
      const { docId } = payload || {};
      if (!docId || !socket.rooms.has(docId) || !roomManager.hasSocket(docId, socket.id)) {
        if (callback) callback({ success: false, error: 'Unauthorized or invalid room' });
        return;
      }
      try {
        const success = await roomManager.flushPersistence(docId);
        if (callback) callback({ success });
      } catch (err: any) {
        if (callback) callback({ success: false, error: err.message });
      }
    });

    // Leave a document editing room
    socket.on('leave-document', (payload: { docId: string }) => {
      const { docId } = payload || {};
      if (!docId) return;

      // Clean up and immediately broadcast awareness eviction for this socket
      evictSocketAwareness(docId, socket.id, (update) => {
        socket.to(docId).emit('awareness-update', {
          docId,
          update: Buffer.from(update),
        });
      });

      socket.leave(docId);
      roomManager.removeSocket(docId, socket.id);
      socket.to(docId).emit('user-left', {
        docId,
        user: { id: user.id, name: user.name },
      });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      const affectedRooms = roomManager.getRoomsForSocket(socket.id);
      for (const docId of affectedRooms) {
        evictSocketAwareness(docId, socket.id, (update) => {
          socket.to(docId).emit('awareness-update', {
            docId,
            update: Buffer.from(update),
          });
        });

        roomManager.removeSocket(docId, socket.id);
        socket.to(docId).emit('user-left', {
          docId,
          user: { id: user.id, name: user.name },
        });
      }
      if (env.NODE_ENV !== 'test') {
        console.log(`[Socket] User disconnected: ${user.name} (${user.id})`);
      }
    });
  });
}

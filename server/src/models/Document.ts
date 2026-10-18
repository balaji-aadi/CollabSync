import mongoose, { Document as MongooseDoc, Model, Schema } from 'mongoose';

export interface IDocument extends MongooseDoc {
  _id: mongoose.Types.ObjectId;
  title: string;
  owner: mongoose.Types.ObjectId;
  collaborators: mongoose.Types.ObjectId[];
  contentBinary?: Buffer | null;
  lastSavedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const DocumentSchema = new Schema<IDocument>(
  {
    title: {
      type: String,
      required: [true, 'Document title is required'],
      trim: true,
      maxlength: [120, 'Title cannot exceed 120 characters'],
      default: 'Untitled Document',
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Document owner is required'],
      index: true,
    },
    collaborators: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    contentBinary: {
      type: Buffer,
      default: null,
    },
    lastSavedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient querying of accessible documents
DocumentSchema.index({ owner: 1, updatedAt: -1 });
DocumentSchema.index({ collaborators: 1, updatedAt: -1 });

export const DocumentModel: Model<IDocument> = mongoose.model<IDocument>('Document', DocumentSchema);

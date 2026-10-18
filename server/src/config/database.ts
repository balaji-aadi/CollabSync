import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDatabase(uri?: string): Promise<typeof mongoose> {
  const mongoUri = uri || env.MONGODB_URI;
  try {
    const conn = await mongoose.connect(mongoUri);
    if (env.NODE_ENV !== 'test') {
      console.log(`[Database] Connected to MongoDB: ${conn.connection.host}/${conn.connection.name}`);
    }
    return conn;
  } catch (error) {
    console.error('[Database] Failed to connect to MongoDB:', error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await mongoose.disconnect();
    if (env.NODE_ENV !== 'test') {
      console.log('[Database] Disconnected from MongoDB');
    }
  } catch (error) {
    console.error('[Database] Error disconnecting from MongoDB:', error);
  }
}

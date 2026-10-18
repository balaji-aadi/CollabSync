import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { registerSocketHandlers } from './sockets/socketHandler.js';

import { roomManager } from './sockets/roomManager.js';

export async function startServer() {
  // Connect to MongoDB
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);

  // Initialize Socket.IO
  const io = new SocketIOServer(server, {
    cors: {
      origin: [env.CLIENT_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  registerSocketHandlers(io);

  // Start listening
  const port = env.PORT;
  server.listen(port, () => {
    console.log(`[Server] CollabSync backend running on port ${port} (${env.NODE_ENV})`);
    console.log(`[Server] CORS client origin: ${env.CLIENT_ORIGIN}`);
  });

  // Graceful shutdown
  const handleShutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
    try {
      console.log('[Server] Flushing pending document updates to database...');
      await roomManager.flushAll();
      console.log('[Server] All document updates flushed successfully');
    } catch (err: any) {
      console.error('[Server] Error flushing document updates on shutdown:', err.message);
    }

    io.close(() => {
      console.log('[Server] Closed Socket.IO connections');
    });
    server.close(async () => {
      console.log('[Server] Closed HTTP server');
      await disconnectDatabase();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  return { server, io, app };
}

// Auto-run if executed directly
if (process.env.NODE_ENV !== 'test') {
  startServer().catch((err) => {
    console.error('[Server] Fatal startup error:', err);
    process.exit(1);
  });
}

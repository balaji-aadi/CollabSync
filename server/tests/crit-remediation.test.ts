import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import request from 'supertest';
import * as Y from 'yjs';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { registerSocketHandlers } from '../src/sockets/socketHandler.js';
import { roomManager, SaveStatusType } from '../src/sockets/roomManager.js';
import { DocumentModel } from '../src/models/Document.js';
import { setupTestDB, clearTestDB, teardownTestDB } from './setup.js';

describe('Phase 2.1: Critical Concurrency & Persistence Remediation Suite', () => {
  let server: http.Server;
  let ioServer: SocketIOServer;
  let serverPort: number;
  let app: any;

  beforeAll(async () => {
    await setupTestDB();
    app = createApp();
    server = http.createServer(app);
    ioServer = new SocketIOServer(server, { transports: ['websocket'] });
    registerSocketHandlers(ioServer);

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        resolve();
      });
    });
  }, 120000);

  afterAll(async () => {
    if (ioServer) {
      await new Promise<void>((resolve) => {
        ioServer.close(() => {
          if (server) {
            server.close(() => resolve());
          } else {
            resolve();
          }
        });
      });
    } else if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    roomManager.clearAllRooms();
    roomManager.setIdleTimeout(10 * 60 * 1000);
  });

  function createSocket(token: string): ClientSocketType {
    return ClientSocket(`http://localhost:${serverPort}`, {
      auth: { token },
      transports: ['websocket'],
      autoConnect: true,
    });
  }

  async function registerAndLogin(name: string, email: string) {
    const res = await request(app).post('/api/auth/register').send({
      name,
      email,
      password: 'Password123!',
    });
    return {
      token: res.body.data.token as string,
      user: res.body.data.user as { id: string; name: string; email: string },
    };
  }

  // =========================================================================
  // CRIT-01: IDLE EVICTION RACE CONDITION TESTS
  // =========================================================================
  describe('CRIT-01: Idle Eviction Race Condition', () => {
    it('aborts eviction and preserves active Y.Doc when a client rejoins while flush is paused', async () => {
      const { token: token1 } = await registerAndLogin('User One', 'user1.crit@collabsync.dev');
      const { token: token2, user: user2 } = await registerAndLogin('User Two', 'user2.crit@collabsync.dev');

      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token1}`)
        .send({ title: 'CRIT-01 Race Test Doc' });
      const docId = docRes.body.data.document._id;

      // Add User 2 as collaborator
      await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ email: user2.email });

      // Connect User 1 and make an initial edit
      const socket1 = createSocket(token1);
      await new Promise<void>((res) => socket1.on('connect', res));
      await new Promise<void>((res) => socket1.emit('join-document', { docId }, () => res()));

      const user1Doc = new Y.Doc();
      user1Doc.getText('content').insert(0, 'Initial edit from User 1.');
      await new Promise<void>((res) => {
        socket1.emit(
          'document-update',
          { docId, update: Array.from(Y.encodeStateAsUpdate(user1Doc)) },
          () => res()
        );
      });

      // Set short eviction timeout for test
      roomManager.setIdleTimeout(20);

      // Deterministically intercept DocumentModel.updateOne to pause persistence during eviction
      const originalUpdateOne = DocumentModel.updateOne;
      let resumeFlushPromise: () => void = () => {};
      const pausePromise = new Promise<void>((res) => {
        resumeFlushPromise = res;
      });

      let flushStartedResolve: () => void = () => {};
      const flushStartedPromise = new Promise<void>((res) => {
        flushStartedResolve = res;
      });

      DocumentModel.updateOne = (async (...args: any[]) => {
        flushStartedResolve();
        await pausePromise;
        return originalUpdateOne.apply(DocumentModel, args as any);
      }) as any;

      try {
        // User 1 disconnects. Active sockets becomes 0.
        socket1.disconnect();

        // Wait for eviction timer to fire and pause inside updateOne
        await flushStartedPromise;
        expect(roomManager.getRoomSize(docId)).toBe(0);

        // While eviction flush is in-flight, User 2 connects and joins the room!
        const socket2 = createSocket(token2);
        await new Promise<void>((res) => socket2.on('connect', res));
        await new Promise<void>((res) => socket2.emit('join-document', { docId }, () => res()));

        // User 2 adds edits
        const user2Doc = new Y.Doc();
        user2Doc.getText('content').insert(0, 'User 2 joined during eviction. ');
        await new Promise<void>((res) => {
          socket2.emit(
            'document-update',
            { docId, update: Array.from(Y.encodeStateAsUpdate(user2Doc)) },
            () => res()
          );
        });

        expect(roomManager.getRoomSize(docId)).toBe(1);

        // Now resume and complete the eviction flush
        resumeFlushPromise();

        // Wait for flush promise resolution
        await new Promise((r) => setTimeout(r, 50));

        // VERIFY CRIT-01 GUARANTEES:
        // 1. Room must NOT have been evicted or deleted from RoomManager
        expect(roomManager.hasRoom(docId)).toBe(true);

        // 2. The active Y.Doc must remain alive, functional, and not destroyed
        const activeRoom = roomManager.getOrCreateRoom(docId);
        expect(activeRoom.activeSockets.size).toBe(1);

        // 3. User 2 can make subsequent edits without errors
        const subsequentDoc = new Y.Doc();
        subsequentDoc.getText('content').insert(0, 'Subsequent edit after avoided eviction.');
        await new Promise<void>((res) => {
          socket2.emit(
            'document-update',
            { docId, update: Array.from(Y.encodeStateAsUpdate(subsequentDoc)) },
            () => res()
          );
        });

        // 4. Persistence works and commits combined content to MongoDB
        await roomManager.flushPersistence(docId);
        const persisted = await DocumentModel.findById(docId);
        expect(persisted?.contentBinary).not.toBeNull();

        const checkDoc = new Y.Doc();
        Y.applyUpdate(checkDoc, new Uint8Array(persisted!.contentBinary!));
        const fullContent = checkDoc.getText('content').toString();

        expect(fullContent).toContain('Initial edit from User 1.');
        expect(fullContent).toContain('User 2 joined during eviction.');
        expect(fullContent).toContain('Subsequent edit after avoided eviction.');

        socket2.disconnect();
      } finally {
        DocumentModel.updateOne = originalUpdateOne;
      }
    });

    it('safely evicts room when no clients rejoin during eviction', async () => {
      const { token } = await registerAndLogin('Normal User', 'normal.crit@collabsync.dev');
      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Normal Eviction Doc' });
      const docId = docRes.body.data.document._id;

      roomManager.setIdleTimeout(50);

      const socket = createSocket(token);
      await new Promise<void>((res) => socket.on('connect', res));
      await new Promise<void>((res) => socket.emit('join-document', { docId }, () => res()));

      const clientDoc = new Y.Doc();
      clientDoc.getText('content').insert(0, 'Content to be safely evicted.');
      await new Promise<void>((res) => {
        socket.emit(
          'document-update',
          { docId, update: Array.from(Y.encodeStateAsUpdate(clientDoc)) },
          () => res()
        );
      });

      socket.disconnect();

      // Wait for 50ms idle timeout + flush completion
      await new Promise((r) => setTimeout(r, 150));

      // Room must be cleanly evicted from memory
      expect(roomManager.hasRoom(docId)).toBe(false);

      // But persisted cleanly in MongoDB
      const dbDoc = await DocumentModel.findById(docId);
      expect(dbDoc?.contentBinary).not.toBeNull();
      const restored = new Y.Doc();
      Y.applyUpdate(restored, new Uint8Array(dbDoc!.contentBinary!));
      expect(restored.getText('content').toString()).toBe('Content to be safely evicted.');
    });
  });

  // =========================================================================
  // CRIT-02: FALSE-POSITIVE PERSISTENCE SUCCESS TESTS
  // =========================================================================
  describe('CRIT-02: False-Positive Persistence Success', () => {
    it('persists and reports saved status when document is matched (matchedCount: 1)', async () => {
      const { token } = await registerAndLogin('Matched User', 'matched.crit@collabsync.dev');
      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Matched Persistence Doc' });
      const docId = docRes.body.data.document._id;

      const room = roomManager.getOrCreateRoom(docId);
      room.isInitialized = true;

      const doc = new Y.Doc();
      doc.getText('content').insert(0, 'Matched persistence test.');
      roomManager.applyUpdate(docId, Y.encodeStateAsUpdate(doc));

      const statusEvents: { status: SaveStatusType; error?: string }[] = [];
      const unsub = roomManager.onSaveStatus((dId, status, _, err) => {
        if (dId === docId) statusEvents.push({ status, error: err });
      });

      const success = await roomManager.flushPersistence(docId);
      unsub();

      expect(success).toBe(true);
      expect(roomManager.isDirty(docId)).toBe(false);

      // Must have emitted 'saved'
      const savedEvent = statusEvents.find((e) => e.status === 'saved');
      expect(savedEvent).toBeDefined();

      const dbDoc = await DocumentModel.findById(docId);
      expect(dbDoc?.contentBinary).not.toBeNull();
    });

    it('rejects persistence and preserves dirty state when document is missing (matchedCount: 0)', async () => {
      const nonExistentId = new mongoose.Types.ObjectId().toString();

      const room = roomManager.getOrCreateRoom(nonExistentId);
      room.isInitialized = true;

      const doc = new Y.Doc();
      doc.getText('content').insert(0, 'Unsaveable orphaned content.');
      roomManager.applyUpdate(nonExistentId, Y.encodeStateAsUpdate(doc));

      expect(roomManager.isDirty(nonExistentId)).toBe(true);

      const statusEvents: { status: SaveStatusType; error?: string }[] = [];
      const unsub = roomManager.onSaveStatus((dId, status, _, err) => {
        if (dId === nonExistentId) statusEvents.push({ status, error: err });
      });

      const success = await roomManager.flushPersistence(nonExistentId);
      unsub();

      // VERIFY CRIT-02 GUARANTEES:
      // 1. flushPersistence must return false
      expect(success).toBe(false);

      // 2. Room must remain dirty (not falsely marked clean)
      expect(roomManager.isDirty(nonExistentId)).toBe(true);

      // 3. Must emit save-status 'error'
      const errorEvent = statusEvents.find((e) => e.status === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.error).toContain('matchedCount: 0');

      // 4. Must NEVER emit 'saved'
      const savedEvent = statusEvents.find((e) => e.status === 'saved');
      expect(savedEvent).toBeUndefined();
    });

    it('rejects persistence and preserves dirty state when database operation throws', async () => {
      const { token } = await registerAndLogin('Throw User', 'throw.crit@collabsync.dev');
      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'DB Throw Doc' });
      const docId = docRes.body.data.document._id;

      const room = roomManager.getOrCreateRoom(docId);
      room.isInitialized = true;

      const doc = new Y.Doc();
      doc.getText('content').insert(0, 'Content before DB throw.');
      roomManager.applyUpdate(docId, Y.encodeStateAsUpdate(doc));

      const originalUpdateOne = DocumentModel.updateOne;
      DocumentModel.updateOne = (async () => {
        throw new Error('Simulated database connection lost');
      }) as any;

      try {
        const statusEvents: { status: SaveStatusType; error?: string }[] = [];
        const unsub = roomManager.onSaveStatus((dId, status, _, err) => {
          if (dId === docId) statusEvents.push({ status, error: err });
        });

        const success = await roomManager.flushPersistence(docId);
        unsub();

        expect(success).toBe(false);
        expect(roomManager.isDirty(docId)).toBe(true);

        const errorEvent = statusEvents.find((e) => e.status === 'error');
        expect(errorEvent).toBeDefined();
        expect(errorEvent?.error).toContain('Simulated database connection lost');

        const savedEvent = statusEvents.find((e) => e.status === 'saved');
        expect(savedEvent).toBeUndefined();
      } finally {
        DocumentModel.updateOne = originalUpdateOne;
      }
    });

    it('proves a failed persistence operation never emits a false saved status', async () => {
      const deletedDocRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${(await registerAndLogin('Delete User', 'del.crit@collabsync.dev')).token}`)
        .send({ title: 'Deleted Doc' });
      const docId = deletedDocRes.body.data.document._id;

      const room = roomManager.getOrCreateRoom(docId);
      room.isInitialized = true;
      roomManager.applyUpdate(docId, Y.encodeStateAsUpdate(new Y.Doc()));

      // Explicitly delete document from database behind RoomManager's back
      await DocumentModel.deleteOne({ _id: docId });

      const emittedStatuses: SaveStatusType[] = [];
      const unsub = roomManager.onSaveStatus((dId, status) => {
        if (dId === docId) emittedStatuses.push(status);
      });

      const result = await roomManager.flushPersistence(docId);
      unsub();

      expect(result).toBe(false);
      expect(emittedStatuses).toContain('error');
      expect(emittedStatuses).not.toContain('saved');
    });
  });
});

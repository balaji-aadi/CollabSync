import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import request from 'supertest';
import * as Y from 'yjs';
import { encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';
import { createApp } from '../src/app.js';
import { registerSocketHandlers } from '../src/sockets/socketHandler.js';
import { roomManager } from '../src/sockets/roomManager.js';
import { DocumentModel } from '../src/models/Document.js';
import { setupTestDB, clearTestDB, teardownTestDB } from './setup.js';

describe('Phase 2: Durable Persistence, Reconnection Recovery & Live Awareness Suite', () => {
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
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      ioServer.close(() => {
        server.close(() => resolve());
      });
    });
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearTestDB();
    roomManager.clearAllRooms();
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

  it('1. Persists document Yjs binary state to MongoDB via debounced write-behind', async () => {
    const { token } = await registerAndLogin('Author Alice', 'alice.persist@collabsync.dev');
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Persistence Test Spec' });
    const docId = docRes.body.data.document._id;

    // Verify initial contentBinary is null
    const initialDoc = await DocumentModel.findById(docId);
    expect(initialDoc?.contentBinary).toBeNull();

    const socket = createSocket(token);
    await new Promise<void>((resolve) => socket.on('connect', resolve));

    await new Promise<void>((resolve) => {
      socket.emit('join-document', { docId }, () => resolve());
    });

    // Make an edit
    const clientDoc = new Y.Doc();
    clientDoc.getText('content').insert(0, 'Durable Yjs persistence test content.');
    const update = Y.encodeStateAsUpdate(clientDoc);

    // Track save-status transitions
    const saveStatusPromise = new Promise<{ status: string; lastSavedAt?: string }>((resolve) => {
      socket.on('save-status', (payload) => {
        if (payload.status === 'saved') {
          resolve(payload);
        }
      });
    });

    await new Promise<void>((resolve) => {
      socket.emit('document-update', { docId, update: Array.from(update) }, () => resolve());
    });

    // Room must immediately be marked dirty
    expect(roomManager.isDirty(docId)).toBe(true);

    // Await flush or debounced persistence
    const savedPayload = await saveStatusPromise;
    expect(savedPayload.status).toBe('saved');
    expect(savedPayload.lastSavedAt).toBeDefined();

    // Verify MongoDB has the binary content stored
    const persistedDoc = await DocumentModel.findById(docId);
    expect(persistedDoc?.contentBinary).not.toBeNull();
    expect(persistedDoc?.contentBinary?.length).toBeGreaterThan(0);
    expect(persistedDoc?.lastSavedAt).toBeDefined();

    // Decode persisted binary update to verify content
    const verifiedDoc = new Y.Doc();
    Y.applyUpdate(verifiedDoc, new Uint8Array(persistedDoc!.contentBinary!));
    expect(verifiedDoc.getText('content').toString()).toBe('Durable Yjs persistence test content.');

    socket.disconnect();
  });

  it('2. Recovers document state after simulated server restart or room cache eviction', async () => {
    const { token } = await registerAndLogin('Restart User', 'restart@collabsync.dev');
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Server Restart Resilience' });
    const docId = docRes.body.data.document._id;

    // 1. First session edits and persists content
    const socket1 = createSocket(token);
    await new Promise<void>((resolve) => socket1.on('connect', resolve));
    await new Promise<void>((resolve) => socket1.emit('join-document', { docId }, () => resolve()));

    const initialDoc = new Y.Doc();
    initialDoc.getText('content').insert(0, 'Critical content before crash.');
    await new Promise<void>((resolve) => {
      socket1.emit(
        'document-update',
        {
          docId,
          update: Array.from(Y.encodeStateAsUpdate(initialDoc)),
        },
        () => resolve()
      );
    });

    // Explicitly flush to database
    await roomManager.flushPersistence(docId);
    socket1.disconnect();

    // 2. SIMULATE COMPLETE SERVER CRASH / RESTART: Clear all in-memory rooms
    roomManager.clearAllRooms();
    expect(roomManager.hasRoom(docId)).toBe(false);

    // 3. User reconnects after restart
    const socket2 = createSocket(token);
    await new Promise<void>((resolve) => socket2.on('connect', resolve));

    const restoredStatePromise = new Promise<Uint8Array>((resolve) => {
      socket2.on('initial-state', (payload) => {
        resolve(new Uint8Array(payload.update));
      });
    });

    socket2.emit('join-document', { docId });
    const restoredBinary = await restoredStatePromise;

    // 4. Verify restored content matches pre-crash state
    const reconstitutedDoc = new Y.Doc();
    Y.applyUpdate(reconstitutedDoc, restoredBinary);
    expect(reconstitutedDoc.getText('content').toString()).toBe('Critical content before crash.');

    // 5. Subsequent edits after restart continue synchronizing normally
    const subsequentDoc = new Y.Doc();
    subsequentDoc.getText('content').insert(0, ' Post-restart continuation.');
    await new Promise<void>((resolve) => {
      socket2.emit(
        'document-update',
        {
          docId,
          update: Array.from(Y.encodeStateAsUpdate(subsequentDoc)),
        },
        () => resolve()
      );
    });

    await roomManager.flushPersistence(docId);
    const finalDoc = await DocumentModel.findById(docId);
    const finalReconstituted = new Y.Doc();
    Y.applyUpdate(finalReconstituted, new Uint8Array(finalDoc!.contentBinary!));
    expect(finalReconstituted.getText('content').toString()).toContain('Critical content before crash.');
    expect(finalReconstituted.getText('content').toString()).toContain('Post-restart continuation.');

    socket2.disconnect();
  });

  it('3. Synchronizes missing updates upon reconnection via Yjs 2-step sync protocol', async () => {
    const { token: tokenA } = await registerAndLogin('User A', 'usera.sync@collabsync.dev');
    const { token: tokenB, user: userB } = await registerAndLogin('User B', 'userb.sync@collabsync.dev');

    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Reconnection Differential Sync' });
    const docId = docRes.body.data.document._id;

    // Share with User B
    await request(app)
      .post(`/api/documents/${docId}/collaborators`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: userB.email });

    // User A and User B connect
    const socketA = createSocket(tokenA);
    const socketB = createSocket(tokenB);

    await Promise.all([
      new Promise<void>((res) => socketA.on('connect', res)),
      new Promise<void>((res) => socketB.on('connect', res)),
    ]);

    await Promise.all([
      new Promise<void>((res) => socketA.emit('join-document', { docId }, () => res())),
      new Promise<void>((res) => socketB.emit('join-document', { docId }, () => res())),
    ]);

    const docA = new Y.Doc();
    const docB = new Y.Doc();

    // Initial shared text
    docA.getText('content').insert(0, 'Initial base document. ');
    socketA.emit('document-update', {
      docId,
      update: Array.from(Y.encodeStateAsUpdate(docA)),
    });
    await new Promise((r) => setTimeout(r, 100));

    // User B disconnects (simulating drop)
    socketB.disconnect();

    // User A makes additional edits while User B is offline
    docA.getText('content').insert(docA.getText('content').length, 'User A edited while B was away. ');
    socketA.emit('document-update', {
      docId,
      update: Array.from(Y.encodeStateAsUpdate(docA)),
    });
    await new Promise((r) => setTimeout(r, 100));

    // User B also makes local offline edits while disconnected
    docB.getText('content').insert(0, 'Initial base document. ');
    docB.getText('content').insert(docB.getText('content').length, 'User B offline note. ');

    // User B reconnects with state vector
    const socketBReconnect = createSocket(tokenB);
    await new Promise<void>((res) => socketBReconnect.on('connect', res));

    // Listen for catch-up diff
    const diffPromise = new Promise<Uint8Array>((resolve) => {
      socketBReconnect.on('sync-step-2', (payload) => {
        resolve(new Uint8Array(payload.update));
      });
    });

    const stateVectorB = Y.encodeStateVector(docB);
    socketBReconnect.emit('join-document', {
      docId,
      stateVector: Array.from(stateVectorB),
    });

    const diffUpdate = await diffPromise;
    Y.applyUpdate(docB, diffUpdate);

    // User B contributes its offline edits via sync-step-2
    const clientDiff = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA));
    if (clientDiff.length > 0) {
      socketBReconnect.emit('sync-step-2', { docId, update: Array.from(clientDiff) });
    }

    await new Promise((r) => setTimeout(r, 200));

    // Fetch compiled state from server
    const serverState = roomManager.getCurrentState(docId);
    const converged = new Y.Doc();
    Y.applyUpdate(converged, serverState);

    const resultText = converged.getText('content').toString();
    expect(resultText).toContain('Initial base document.');
    expect(resultText).toContain('User A edited while B was away.');
    expect(resultText).toContain('User B offline note.');

    socketA.disconnect();
    socketBReconnect.disconnect();
  });

  it('4. Handles duplicate updates and idempotent resynchronization safely', async () => {
    const { token } = await registerAndLogin('Idempotent User', 'idempotent@collabsync.dev');
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Idempotency Test' });
    const docId = docRes.body.data.document._id;

    const socket = createSocket(token);
    await new Promise<void>((res) => socket.on('connect', res));
    await new Promise<void>((res) => socket.emit('join-document', { docId }, () => res()));

    const clientDoc = new Y.Doc();
    clientDoc.getText('content').insert(0, 'Idempotent line 1.');
    const rawUpdate = Array.from(Y.encodeStateAsUpdate(clientDoc));

    // Emit the exact same update 3 times
    socket.emit('document-update', { docId, update: rawUpdate });
    socket.emit('document-update', { docId, update: rawUpdate });
    socket.emit('document-update', { docId, update: rawUpdate });

    await new Promise((r) => setTimeout(r, 100));

    const checkDoc = new Y.Doc();
    Y.applyUpdate(checkDoc, roomManager.getCurrentState(docId));
    // Must NOT duplicate content
    expect(checkDoc.getText('content').toString()).toBe('Idempotent line 1.');

    socket.disconnect();
  });

  it('5. Flushes pending writes before room eviction and handles eviction lifecycle', async () => {
    const { token } = await registerAndLogin('Eviction User', 'eviction@collabsync.dev');
    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Eviction Flush Test' });
    const docId = docRes.body.data.document._id;

    // Set a very short idle timeout (100ms) for test
    roomManager.setIdleTimeout(100);

    const socket = createSocket(token);
    await new Promise<void>((res) => socket.on('connect', res));
    await new Promise<void>((res) => socket.emit('join-document', { docId }, () => res()));

    const clientDoc = new Y.Doc();
    clientDoc.getText('content').insert(0, 'Unpersisted text before disconnect.');
    await new Promise<void>((resolve) => {
      socket.emit(
        'document-update',
        {
          docId,
          update: Array.from(Y.encodeStateAsUpdate(clientDoc)),
        },
        () => resolve()
      );
    });

    // Disconnect socket immediately while save timer is still pending
    socket.disconnect();

    // Wait for idle timeout (100ms) + grace period
    await new Promise((r) => setTimeout(r, 250));

    // Room must have been evicted from memory
    expect(roomManager.hasRoom(docId)).toBe(false);

    // But MongoDB must have the flushed content!
    const persisted = await DocumentModel.findById(docId);
    expect(persisted?.contentBinary).not.toBeNull();
    const restored = new Y.Doc();
    Y.applyUpdate(restored, new Uint8Array(persisted!.contentBinary!));
    expect(restored.getText('content').toString()).toBe('Unpersisted text before disconnect.');

    // Restore standard timeout
    roomManager.setIdleTimeout(10 * 60 * 1000);
  });

  it('6. Broadcasts ephemeral live awareness updates without database persistence', async () => {
    const { token: tokenA } = await registerAndLogin('Alice Cursor', 'alice.cursor@collabsync.dev');
    const { token: tokenB, user: userB } = await registerAndLogin('Bob Cursor', 'bob.cursor@collabsync.dev');

    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Awareness Broadcast Test' });
    const docId = docRes.body.data.document._id;

    await request(app)
      .post(`/api/documents/${docId}/collaborators`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: userB.email });

    const socketA = createSocket(tokenA);
    const socketB = createSocket(tokenB);

    await Promise.all([
      new Promise<void>((res) => socketA.on('connect', res)),
      new Promise<void>((res) => socketB.on('connect', res)),
    ]);

    await Promise.all([
      new Promise<void>((res) => socketA.emit('join-document', { docId }, () => res())),
      new Promise<void>((res) => socketB.emit('join-document', { docId }, () => res())),
    ]);

    // User B listens for awareness updates
    const awarenessReceivedPromise = new Promise<Uint8Array>((resolve) => {
      socketB.on('awareness-update', (payload) => {
        resolve(new Uint8Array(payload.update));
      });
    });

    // User A emits an awareness cursor update
    const dummyDoc = new Y.Doc();
    const clientAwarenessA = new (await import('y-protocols/awareness')).Awareness(dummyDoc);
    clientAwarenessA.setLocalStateField('user', { name: 'Alice Cursor', color: '#f43f5e' });
    clientAwarenessA.setLocalStateField('cursor', { anchor: 10, head: 15 });

    const awarenessUpdate = encodeAwarenessUpdate(clientAwarenessA, [clientAwarenessA.clientID]);
    socketA.emit('awareness-update', {
      docId,
      update: Array.from(awarenessUpdate),
    });

    const receivedAwareness = await awarenessReceivedPromise;
    expect(receivedAwareness.length).toBeGreaterThan(0);

    const clientAwarenessB = new (await import('y-protocols/awareness')).Awareness(dummyDoc);
    applyAwarenessUpdate(clientAwarenessB, receivedAwareness, 'remote');

    const peerState = clientAwarenessB.getStates().get(clientAwarenessA.clientID);
    expect(peerState?.user?.name).toBe('Alice Cursor');
    expect(peerState?.cursor?.anchor).toBe(10);

    // Verify awareness was NOT written to MongoDB
    await roomManager.flushPersistence(docId);
    const dbDoc = await DocumentModel.findById(docId);
    // contentBinary should be null because no document-update was emitted
    expect(dbDoc?.contentBinary).toBeNull();

    socketA.disconnect();
    socketB.disconnect();
    clientAwarenessA.destroy();
    clientAwarenessB.destroy();
    dummyDoc.destroy();
  });

  it('7. Rejects revoked collaborator on reconnect even if they hold local state', async () => {
    const { token: tokenA } = await registerAndLogin('Owner Revoke', 'owner.revoke@collabsync.dev');
    const { token: tokenB, user: userB } = await registerAndLogin('Revoked Reconnect', 'revoked.reconnect@collabsync.dev');

    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Revocation Reconnect Isolation' });
    const docId = docRes.body.data.document._id;

    // Add User B
    await request(app)
      .post(`/api/documents/${docId}/collaborators`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: userB.email });

    // Revoke User B access via REST API
    const revokeRes = await request(app)
      .delete(`/api/documents/${docId}/collaborators/${userB.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(revokeRes.status).toBe(200);

    // User B attempts to connect and join room with a state vector
    const socketB = createSocket(tokenB);
    await new Promise<void>((res) => socketB.on('connect', res));

    const errorPromise = new Promise<any>((resolve) => {
      socketB.on('document-error', (err) => resolve(err));
    });

    socketB.emit('join-document', {
      docId,
      stateVector: [0],
    });

    const errPayload = await errorPromise;
    expect(errPayload.code).toBe('FORBIDDEN');
    expect(roomManager.getRoomSize(docId)).toBe(0);

    socketB.disconnect();
  });
});

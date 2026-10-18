import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import * as Y from 'yjs';
import { createApp } from '../src/app.js';
import { registerSocketHandlers } from '../src/sockets/socketHandler.js';
import { roomManager } from '../src/sockets/roomManager.js';
import { DocumentModel } from '../src/models/Document.js';
import { User } from '../src/models/User.js';
import { generateToken } from '../src/middleware/auth.js';
import request from 'supertest';
import { setupTestDB, clearTestDB, teardownTestDB } from './setup.js';

let server: http.Server;
let ioServer: SocketIOServer;
let serverPort: number;
let expressApp: any;

function createClientSocket(token?: string): ClientSocketType {
  return ClientSocket(`http://localhost:${serverPort}`, {
    auth: { token },
    transports: ['websocket'],
    autoConnect: true,
  });
}

describe('Socket.IO Real-Time Collaboration & Room Authorization Suite', () => {
  let userA: any;
  let userB: any;
  let tokenA: string;
  let tokenB: string;
  let docA: any;
  let docB: any;

  beforeAll(async () => {
    await setupTestDB();

    const app = createApp();
    expressApp = app;
    server = http.createServer(app);
    ioServer = new SocketIOServer(server, {
      transports: ['websocket'],
    });
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

    // Create User A
    userA = await User.create({
      name: 'Alice Socket',
      email: 'alice.socket@example.com',
      password: 'Password123!',
    });
    tokenA = generateToken({ id: userA._id.toString(), name: userA.name, email: userA.email });

    // Create User B
    userB = await User.create({
      name: 'Bob Socket',
      email: 'bob.socket@example.com',
      password: 'Password123!',
    });
    tokenB = generateToken({ id: userB._id.toString(), name: userB.name, email: userB.email });

    // Document A owned by Alice
    docA = await DocumentModel.create({
      title: 'Alice Document',
      owner: userA._id,
      collaborators: [],
    });

    // Document B owned by Bob
    docB = await DocumentModel.create({
      title: 'Bob Document',
      owner: userB._id,
      collaborators: [],
    });
  });

  it('rejects unauthenticated socket connections at the handshake', async () => {
    const socket = createClientSocket(undefined);

    const error = await new Promise<any>((resolve) => {
      socket.on('connect_error', (err) => resolve(err));
    });

    expect(error.message).toContain('UNAUTHORIZED');
    socket.disconnect();
  });

  it('allows authenticated socket connections with valid JWT', async () => {
    const socket = createClientSocket(tokenA);

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', (err) => reject(err));
    });

    expect(socket.connected).toBe(true);
    socket.disconnect();
  });

  it('allows authorized user to join document room and receive initial-state', async () => {
    const socket = createClientSocket(tokenA);

    await new Promise<void>((resolve) => socket.on('connect', resolve));

    const initialStatePromise = new Promise<any>((resolve) => {
      socket.on('initial-state', (data) => resolve(data));
    });

    socket.emit('join-document', { docId: docA._id.toString() });

    const data = await initialStatePromise;
    expect(data.docId).toBe(docA._id.toString());
    expect(data.update).toBeDefined();

    expect(roomManager.getRoomSize(docA._id.toString())).toBe(1);
    socket.disconnect();
  });

  it('strictly rejects unauthorized user from joining another user document room (403 Forbidden)', async () => {
    // Bob attempts to join Alice's private document
    const socketB = createClientSocket(tokenB);
    await new Promise<void>((resolve) => socketB.on('connect', resolve));

    const errorPromise = new Promise<any>((resolve) => {
      socketB.on('document-error', (err) => resolve(err));
    });

    socketB.emit('join-document', { docId: docA._id.toString() });

    const error = await errorPromise;
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toContain('not authorized');

    // Verify Bob was not added to the room
    expect(roomManager.getRoomSize(docA._id.toString())).toBe(0);
    socketB.disconnect();
  });

  it('propagates Yjs document updates between authorized peers and converges state', async () => {
    // Add Bob as collaborator to Alice's document
    docA.collaborators.push(userB._id);
    await docA.save();

    const clientA = createClientSocket(tokenA);
    const clientB = createClientSocket(tokenB);

    await Promise.all([
      new Promise<void>((resolve) => clientA.on('connect', resolve)),
      new Promise<void>((resolve) => clientB.on('connect', resolve)),
    ]);

    // Both join Doc A
    await new Promise<void>((resolve) => {
      clientA.emit('join-document', { docId: docA._id.toString() }, () => resolve());
    });
    await new Promise<void>((resolve) => {
      clientB.emit('join-document', { docId: docA._id.toString() }, () => resolve());
    });

    // Local Y.Doc instances for testing convergence
    const localDocA = new Y.Doc();
    const localDocB = new Y.Doc();

    // Client B listens for incoming updates
    const updateReceivedPromise = new Promise<any>((resolve) => {
      clientB.on('document-update', (data) => {
        resolve(data);
      });
    });

    // Client A inserts text and sends update
    const textA = localDocA.getText('content');
    textA.insert(0, 'Real-time collaborative text!');
    const updatePayload = Array.from(Y.encodeStateAsUpdate(localDocA));

    clientA.emit('document-update', {
      docId: docA._id.toString(),
      update: updatePayload,
    });

    const received = await updateReceivedPromise;
    expect(received.docId).toBe(docA._id.toString());

    // Apply update to Client B's local doc
    Y.applyUpdate(localDocB, new Uint8Array(received.update));
    expect(localDocB.getText('content').toString()).toBe('Real-time collaborative text!');

    clientA.disconnect();
    clientB.disconnect();
  });

  it('isolates document rooms: updates to Doc A do NOT leak into Doc B', async () => {
    const clientA = createClientSocket(tokenA);
    const clientB = createClientSocket(tokenB);

    await Promise.all([
      new Promise<void>((resolve) => clientA.on('connect', resolve)),
      new Promise<void>((resolve) => clientB.on('connect', resolve)),
    ]);

    // Client A joins Doc A; Client B joins Doc B
    await new Promise<void>((resolve) => {
      clientA.emit('join-document', { docId: docA._id.toString() }, () => resolve());
    });
    await new Promise<void>((resolve) => {
      clientB.emit('join-document', { docId: docB._id.toString() }, () => resolve());
    });

    let leaked = false;
    clientB.on('document-update', () => {
      leaked = true;
    });

    // Client A sends update to Doc A
    const sampleDoc = new Y.Doc();
    sampleDoc.getText('content').insert(0, 'Sample text');
    const validUpdate = Array.from(Y.encodeStateAsUpdate(sampleDoc));

    clientA.emit('document-update', {
      docId: docA._id.toString(),
      update: validUpdate,
    });

    // Wait 200ms to ensure no message arrived at Client B
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(leaked).toBe(false);

    clientA.disconnect();
    clientB.disconnect();
  });

  it('cleans up disconnected sockets from room tracking', async () => {
    const socket = createClientSocket(tokenA);
    await new Promise<void>((resolve) => socket.on('connect', resolve));

    await new Promise<void>((resolve) => {
      socket.emit('join-document', { docId: docA._id.toString() }, () => resolve());
    });

    expect(roomManager.getRoomSize(docA._id.toString())).toBe(1);

    socket.disconnect();

    // Wait 100ms for disconnect handler to run
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(roomManager.getRoomSize(docA._id.toString())).toBe(0);
  });

  it('delivers complete compiled initial-state to late-joining collaborators', async () => {
    const clientA = createClientSocket(tokenA);
    await new Promise<void>((resolve) => clientA.on('connect', resolve));

    // Client A joins Doc A
    await new Promise<void>((resolve) => {
      clientA.emit('join-document', { docId: docA._id.toString() }, () => resolve());
    });

    // Client A writes multiple paragraphs of text to Doc A
    const localDocA = new Y.Doc();
    const textA = localDocA.getText('content');
    textA.insert(0, 'Header paragraph.\nSecond paragraph with rich edits.');
    const fullUpdate = Array.from(Y.encodeStateAsUpdate(localDocA));

    clientA.emit('document-update', {
      docId: docA._id.toString(),
      update: fullUpdate,
    });

    // Give server time to apply update to room
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now invite Bob as collaborator to Doc A
    docA.collaborators.push(userB._id);
    await docA.save();

    // Bob (late joiner) connects
    const clientB = createClientSocket(tokenB);
    await new Promise<void>((resolve) => clientB.on('connect', resolve));

    const initialStatePromise = new Promise<any>((resolve) => {
      clientB.on('initial-state', (data) => resolve(data));
    });

    clientB.emit('join-document', { docId: docA._id.toString() });

    const initialData = await initialStatePromise;
    expect(initialData.docId).toBe(docA._id.toString());
    expect(initialData.update).toBeDefined();

    // Verify Bob's local doc receives full compiled state
    const localDocB = new Y.Doc();
    Y.applyUpdate(localDocB, new Uint8Array(initialData.update));
    expect(localDocB.getText('content').toString()).toBe('Header paragraph.\nSecond paragraph with rich edits.');

    clientA.disconnect();
    clientB.disconnect();
  });

  it('evicts active sockets immediately when collaborator access is revoked via API', async () => {
    // Grant Bob collaborator access
    docA.collaborators.push(userB._id);
    await docA.save();

    const clientB = createClientSocket(tokenB);
    await new Promise<void>((resolve) => clientB.on('connect', resolve));

    // Bob joins Doc A room
    await new Promise<void>((resolve) => {
      clientB.emit('join-document', { docId: docA._id.toString() }, () => resolve());
    });

    expect(roomManager.getRoomSize(docA._id.toString())).toBe(1);

    // Bob listens for document-error event
    const accessRevokedPromise = new Promise<any>((resolve) => {
      clientB.on('document-error', (err) => resolve(err));
    });

    // Owner (Alice) revokes Bob's access via REST API
    const res = await request(expressApp)
      .delete(`/api/documents/${docA._id}/collaborators/${userB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);

    // Bob's socket must immediately receive ACCESS_REVOKED
    const err = await accessRevokedPromise;
    expect(err.code).toBe('ACCESS_REVOKED');
    expect(err.message).toContain('revoked');

    // Bob must be removed from the room
    expect(roomManager.getRoomSize(docA._id.toString())).toBe(0);

    // Verify Bob cannot send updates anymore
    const dummyDoc = new Y.Doc();
    dummyDoc.getText('content').insert(0, 'Unauthorized edit');
    const update = Array.from(Y.encodeStateAsUpdate(dummyDoc));

    clientB.emit('document-update', {
      docId: docA._id.toString(),
      update,
    });

    // Content in room remains unchanged
    const state = roomManager.getCurrentState(docA._id.toString());
    const verifyDoc = new Y.Doc();
    Y.applyUpdate(verifyDoc, state);
    expect(verifyDoc.getText('content').toString()).not.toContain('Unauthorized edit');

    clientB.disconnect();
  });

  it('evicts empty rooms after idle timeout expires to prevent unbounded memory growth', async () => {
    // Set 100ms idle timeout for testing
    roomManager.setIdleTimeout(100);

    const socket = createClientSocket(tokenA);
    await new Promise<void>((resolve) => socket.on('connect', resolve));

    await new Promise<void>((resolve) => {
      socket.emit('join-document', { docId: docA._id.toString() }, () => resolve());
    });

    expect(roomManager.hasRoom(docA._id.toString())).toBe(true);
    expect(roomManager.getRoomSize(docA._id.toString())).toBe(1);

    // Socket leaves/disconnects
    socket.disconnect();

    // Wait 50ms (before timeout): room still exists for reload continuity
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(roomManager.hasRoom(docA._id.toString())).toBe(true);

    // Wait another 100ms (after timeout): room must be evicted from memory
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(roomManager.hasRoom(docA._id.toString())).toBe(false);

    // Restore default timeout
    roomManager.setIdleTimeout(10 * 60 * 1000);
  });
});

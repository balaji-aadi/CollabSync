import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import request from 'supertest';
import * as Y from 'yjs';
import { createApp } from '../src/app.js';
import { registerSocketHandlers } from '../src/sockets/socketHandler.js';
import { roomManager } from '../src/sockets/roomManager.js';
import { setupTestDB, clearTestDB, teardownTestDB } from './setup.js';

describe('Phase 1.1 Complete End-to-End Collaboration Smoke Suite (10-Step Specification)', () => {
  let server: http.Server;
  let ioServer: SocketIOServer;
  let serverPort: number;
  let app: any;

  beforeAll(async () => {
    await setupTestDB();
    await clearTestDB();
    roomManager.clearAllRooms();

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

  function createSocket(token: string): ClientSocketType {
    return ClientSocket(`http://localhost:${serverPort}`, {
      auth: { token },
      transports: ['websocket'],
      autoConnect: true,
    });
  }

  it('executes full 10-step multi-user lifecycle with convergence, RBAC, socket eviction, and isolation', async () => {
    // -------------------------------------------------------------------------
    // Step 1: Register User A
    // -------------------------------------------------------------------------
    const resRegA = await request(app).post('/api/auth/register').send({
      name: 'User A',
      email: 'user.a@collabsync.dev',
      password: 'Password123!',
    });
    expect(resRegA.status).toBe(201);
    const userA = resRegA.body.data.user;
    const tokenA = resRegA.body.data.token;
    expect(userA.email).toBe('user.a@collabsync.dev');

    // -------------------------------------------------------------------------
    // Step 2: Register User B
    // -------------------------------------------------------------------------
    const resRegB = await request(app).post('/api/auth/register').send({
      name: 'User B',
      email: 'user.b@collabsync.dev',
      password: 'Password123!',
    });
    expect(resRegB.status).toBe(201);
    const userB = resRegB.body.data.user;
    const tokenB = resRegB.body.data.token;
    expect(userB.email).toBe('user.b@collabsync.dev');

    // -------------------------------------------------------------------------
    // Step 3: Log in as User A and create a document
    // -------------------------------------------------------------------------
    const resLoginA = await request(app).post('/api/auth/login').send({
      email: 'user.a@collabsync.dev',
      password: 'Password123!',
    });
    expect(resLoginA.status).toBe(200);

    const resCreateDoc = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Architecture RFC 101' });

    expect(resCreateDoc.status).toBe(201);
    const docId = resCreateDoc.body.data.document._id;
    expect(resCreateDoc.body.data.document.title).toBe('Architecture RFC 101');
    expect(resCreateDoc.body.data.document.owner.email).toBe('user.a@collabsync.dev');

    // -------------------------------------------------------------------------
    // Step 4: Share the document with User B
    // -------------------------------------------------------------------------
    const resShare = await request(app)
      .post(`/api/documents/${docId}/collaborators`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'user.b@collabsync.dev' });

    expect(resShare.status).toBe(200);
    expect(resShare.body.data.document.collaborators).toHaveLength(1);
    expect(resShare.body.data.document.collaborators[0].email).toBe('user.b@collabsync.dev');

    // -------------------------------------------------------------------------
    // Step 5: Open the same document in both sessions (join Socket.IO room)
    // -------------------------------------------------------------------------
    const socketA = createSocket(tokenA);
    const socketB = createSocket(tokenB);

    await Promise.all([
      new Promise<void>((resolve) => socketA.on('connect', resolve)),
      new Promise<void>((resolve) => socketB.on('connect', resolve)),
    ]);

    const aJoined = new Promise<void>((resolve) => {
      socketA.emit('join-document', { docId }, () => resolve());
    });
    const bJoined = new Promise<void>((resolve) => {
      socketB.emit('join-document', { docId }, () => resolve());
    });
    await Promise.all([aJoined, bJoined]);

    expect(roomManager.getRoomSize(docId)).toBe(2);

    // -------------------------------------------------------------------------
    // Step 6: Type different text from each session and verify that both converge
    // -------------------------------------------------------------------------
    const localDocA = new Y.Doc();
    const localDocB = new Y.Doc();
    const textA = localDocA.getText('content');
    const textB = localDocB.getText('content');

    // Setup update listeners
    const bReceivedUpdate = new Promise<any>((resolve) => {
      socketB.on('document-update', (data) => resolve(data));
    });
    const aReceivedUpdate = new Promise<any>((resolve) => {
      socketA.on('document-update', (data) => resolve(data));
    });

    // Session A inserts prefix
    textA.insert(0, 'Distributed System RFC: ');
    socketA.emit('document-update', {
      docId,
      update: Array.from(Y.encodeStateAsUpdate(localDocA)),
    });

    // Session B inserts concurrent suffix
    textB.insert(0, 'Approved for implementation.');
    socketB.emit('document-update', {
      docId,
      update: Array.from(Y.encodeStateAsUpdate(localDocB)),
    });

    const [updateForB, updateForA] = await Promise.all([bReceivedUpdate, aReceivedUpdate]);
    Y.applyUpdate(localDocB, new Uint8Array(updateForB.update));
    Y.applyUpdate(localDocA, new Uint8Array(updateForA.update));

    // Both sessions must converge to the identical text
    expect(textA.toString()).toBe(textB.toString());

    // -------------------------------------------------------------------------
    // Step 7: Rename document and verify change (both REST and real-time socket broadcast)
    // -------------------------------------------------------------------------
    const bReceivedRename = new Promise<any>((resolve) => {
      socketB.on('document-renamed', (data) => resolve(data));
    });

    const resRename = await request(app)
      .patch(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Architecture RFC 101 - Approved Draft' });

    expect(resRename.status).toBe(200);
    expect(resRename.body.data.document.title).toBe('Architecture RFC 101 - Approved Draft');

    const renamePayload = await bReceivedRename;
    expect(renamePayload.docId).toBe(docId);
    expect(renamePayload.title).toBe('Architecture RFC 101 - Approved Draft');

    // -------------------------------------------------------------------------
    // Step 8: Revoke User B's access and test that socket is kicked
    // -------------------------------------------------------------------------
    const bAccessRevoked = new Promise<any>((resolve) => {
      socketB.on('document-error', (err) => resolve(err));
    });

    const resRevoke = await request(app)
      .delete(`/api/documents/${docId}/collaborators/${userB.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(resRevoke.status).toBe(200);

    const revokedPayload = await bAccessRevoked;
    expect(revokedPayload.code).toBe('ACCESS_REVOKED');
    expect(revokedPayload.message).toContain('revoked');

    // Verify User B is no longer in the room
    expect(roomManager.getRoomSize(docId)).toBe(1);

    // Verify User B cannot emit updates anymore
    const dummy = new Y.Doc();
    dummy.getText('content').insert(0, 'Malicious unapproved edit');
    socketB.emit('document-update', {
      docId,
      update: Array.from(Y.encodeStateAsUpdate(dummy)),
    });

    // Verify room state does NOT contain User B's dropped edit
    const serverState = roomManager.getCurrentState(docId);
    const checkDoc = new Y.Doc();
    Y.applyUpdate(checkDoc, serverState);
    expect(checkDoc.getText('content').toString()).not.toContain('Malicious unapproved edit');

    // -------------------------------------------------------------------------
    // Step 9: Attempt to access the private document as unauthorized User C
    // -------------------------------------------------------------------------
    const resRegC = await request(app).post('/api/auth/register').send({
      name: 'User C',
      email: 'user.c@collabsync.dev',
      password: 'Password123!',
    });
    const tokenC = resRegC.body.data.token;

    // HTTP check
    const resGetC = await request(app)
      .get(`/api/documents/${docId}`)
      .set('Authorization', `Bearer ${tokenC}`);
    expect(resGetC.status).toBe(403);
    expect(resGetC.body.error.code).toBe('FORBIDDEN');

    // Socket check
    const socketC = createSocket(tokenC);
    await new Promise<void>((resolve) => socketC.on('connect', resolve));
    const cErrorPromise = new Promise<any>((resolve) => {
      socketC.on('document-error', (err) => resolve(err));
    });
    socketC.emit('join-document', { docId });
    const cError = await cErrorPromise;
    expect(cError.code).toBe('FORBIDDEN');
    socketC.disconnect();

    // -------------------------------------------------------------------------
    // Step 10: Disconnect one client and verify the remaining editor continues functioning
    // -------------------------------------------------------------------------
    socketB.disconnect();

    // User A writes additional text
    textA.insert(textA.toString().length, '\nAddendum: Follow-up action items.');
    socketA.emit('document-update', {
      docId,
      update: Array.from(Y.encodeStateAsUpdate(localDocA)),
    });

    // Give server time to apply
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify server room state contains User A's final text
    const finalServerState = roomManager.getCurrentState(docId);
    const finalDoc = new Y.Doc();
    Y.applyUpdate(finalDoc, finalServerState);
    expect(finalDoc.getText('content').toString()).toContain('Addendum: Follow-up action items.');

    socketA.disconnect();
  });
});

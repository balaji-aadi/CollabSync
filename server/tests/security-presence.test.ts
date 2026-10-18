import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import request from 'supertest';
import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import { createApp } from '../src/app.js';
import { registerSocketHandlers } from '../src/sockets/socketHandler.js';
import { roomManager } from '../src/sockets/roomManager.js';
import { DocumentModel } from '../src/models/Document.js';
import { setupTestDB, clearTestDB, teardownTestDB } from './setup.js';

describe('Phase 2.2: Security & Presence Hardening Suite', () => {
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
      forceNew: true,
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

  describe('Task 1 & Task 2: Awareness and Presence Security', () => {
    it('enforces server-side authenticated identity and strips spoofed names, emails, and roles from awareness', async () => {
      const owner = await registerAndLogin('Owner Olivia', 'olivia@security.dev');
      const hacker = await registerAndLogin('Hacker Bob', 'bob@security.dev');

      // Create doc and add hacker as collaborator
      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Awareness Security Doc' });
      const docId = docRes.body.data.document._id;

      await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: hacker.user.email });

      const ownerSocket = createSocket(owner.token);
      const hackerSocket = createSocket(hacker.token);

      await Promise.all([
        new Promise<void>((resolve) => ownerSocket.on('connect', resolve)),
        new Promise<void>((resolve) => hackerSocket.on('connect', resolve)),
      ]);

      await new Promise<void>((resolve) => ownerSocket.emit('join-document', { docId }, () => resolve()));
      await new Promise<void>((resolve) => hackerSocket.emit('join-document', { docId }, () => resolve()));

      // Hacker crafts a malicious awareness payload claiming to be Admin with fake email and role
      const hackerDoc = new Y.Doc();
      const hackerAw = new Awareness(hackerDoc);
      hackerAw.setLocalState({
        user: {
          id: 'fake-admin-id',
          name: 'CEO Administrator',
          email: 'ceo@collabsync.dev',
          role: 'superadmin',
        },
        cursor: { anchor: 42, head: 42 },
      });

      const maliciousUpdate = encodeAwarenessUpdate(hackerAw, [hackerAw.clientID]);

      // Owner listens for awareness update
      const ownerReceivedPromise = new Promise<any>((resolve) => {
        ownerSocket.on('awareness-update', (payload) => {
          const remoteDoc = new Y.Doc();
          const remoteAw = new Awareness(remoteDoc);
          applyAwarenessUpdate(remoteAw, new Uint8Array(payload.update), 'remote');
          const states = Array.from(remoteAw.getStates().values());
          resolve(states);
        });
      });

      hackerSocket.emit('awareness-update', {
        docId,
        update: Array.from(maliciousUpdate),
      });

      const receivedStates = await ownerReceivedPromise;
      expect(receivedStates.length).toBeGreaterThan(0);

      const hackerState = receivedStates.find((s: any) => s.cursor?.anchor === 42);
      expect(hackerState).toBeDefined();

      // Verified: Spoofed name is overridden with actual authenticated user name
      expect(hackerState.user.name).toBe('Hacker Bob');
      expect(hackerState.user.id).toBe(hacker.user.id);
      // Verified: Sensitive / spoofed fields are completely stripped
      expect(hackerState.user.email).toBeUndefined();
      expect(hackerState.user.role).toBeUndefined();
      expect(hackerState.cursor).toEqual({ anchor: 42, head: 42 });

      ownerSocket.disconnect();
      hackerSocket.disconnect();
    });

    it('prevents client ID hijacking across different sockets', async () => {
      const owner = await registerAndLogin('Alice Owner', 'alice.hijack@security.dev');
      const mallory = await registerAndLogin('Mallory', 'mallory@security.dev');

      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Hijack Prevention Doc' });
      const docId = docRes.body.data.document._id;

      await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: mallory.user.email });

      const aliceSocket = createSocket(owner.token);
      const mallorySocket = createSocket(mallory.token);

      await Promise.all([
        new Promise<void>((resolve) => aliceSocket.on('connect', resolve)),
        new Promise<void>((resolve) => mallorySocket.on('connect', resolve)),
      ]);

      await new Promise<void>((resolve) => aliceSocket.emit('join-document', { docId }, () => resolve()));
      await new Promise<void>((resolve) => mallorySocket.emit('join-document', { docId }, () => resolve()));

      // Alice registers legitimate clientID 9001
      const aliceDoc = new Y.Doc();
      const aliceAw = new Awareness(aliceDoc);
      aliceAw.setLocalState({
        user: { name: 'Alice' },
        cursor: { anchor: 10, head: 10 },
      });
      // Force clientID
      const aliceCid = 9001;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint(encoder, aliceCid);
      encoding.writeVarUint(encoder, 1); // clock
      encoding.writeVarString(
        encoder,
        JSON.stringify({ user: { name: 'Alice' }, cursor: { anchor: 10, head: 10 } })
      );
      const alicePayload = encoding.toUint8Array(encoder);

      aliceSocket.emit('awareness-update', {
        docId,
        update: Array.from(alicePayload),
      });

      // Wait a moment for roomManager to register clientID 9001 to aliceSocket
      await new Promise((r) => setTimeout(r, 100));

      // Mallory attempts to send an awareness update using Alice's clientID 9001
      const malloryEncoder = encoding.createEncoder();
      encoding.writeVarUint(malloryEncoder, 1);
      encoding.writeVarUint(malloryEncoder, aliceCid); // Spoofer uses Alice's clientID
      encoding.writeVarUint(malloryEncoder, 2);
      encoding.writeVarString(
        malloryEncoder,
        JSON.stringify({ user: { name: 'Mallory Impersonating' }, cursor: { anchor: 999, head: 999 } })
      );
      const spoofedPayload = encoding.toUint8Array(malloryEncoder);

      let malloryHijackReceived = false;
      aliceSocket.on('awareness-update', (payload) => {
        const testAw = new Awareness(new Y.Doc());
        applyAwarenessUpdate(testAw, new Uint8Array(payload.update), 'test');
        const state = testAw.getStates().get(aliceCid);
        if (state && (state as any).cursor?.anchor === 999) {
          malloryHijackReceived = true;
        }
      });

      mallorySocket.emit('awareness-update', {
        docId,
        update: Array.from(spoofedPayload),
      });

      await new Promise((r) => setTimeout(r, 200));

      // Assert that Mallory's attempt to hijack Alice's clientID was blocked
      expect(malloryHijackReceived).toBe(false);

      aliceSocket.disconnect();
      mallorySocket.disconnect();
    });

    it('immediately cleans up awareness states on client disconnect without waiting for timeout', async () => {
      const user1 = await registerAndLogin('User One', 'user1@presence.dev');
      const user2 = await registerAndLogin('User Two', 'user2@presence.dev');

      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${user1.token}`)
        .send({ title: 'Immediate Eviction Doc' });
      const docId = docRes.body.data.document._id;

      await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${user1.token}`)
        .send({ email: user2.user.email });

      const socket1 = createSocket(user1.token);
      const socket2 = createSocket(user2.token);

      await Promise.all([
        new Promise<void>((resolve) => socket1.on('connect', resolve)),
        new Promise<void>((resolve) => socket2.on('connect', resolve)),
      ]);

      await new Promise<void>((resolve) => socket1.emit('join-document', { docId }, () => resolve()));
      await new Promise<void>((resolve) => socket2.emit('join-document', { docId }, () => resolve()));

      // Socket 1 sends awareness
      const u1Doc = new Y.Doc();
      const u1Aw = new Awareness(u1Doc);
      u1Aw.setLocalState({ cursor: { anchor: 5, head: 5 } });
      const cid = u1Aw.clientID;
      const update = encodeAwarenessUpdate(u1Aw, [cid]);

      const peerAw = new Awareness(new Y.Doc());
      socket2.on('awareness-update', (payload) => {
        applyAwarenessUpdate(peerAw, new Uint8Array(payload.update), 'remote');
      });

      socket1.emit('awareness-update', {
        docId,
        update: Array.from(update),
      });

      // Wait until peer receives Socket 1's awareness
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (peerAw.getStates().has(cid)) {
            clearInterval(interval);
            resolve();
          }
        }, 20);
      });

      expect(peerAw.getStates().has(cid)).toBe(true);

      // Now Socket 1 disconnects
      const removalPromise = new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!peerAw.getStates().has(cid)) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 20);
      });

      socket1.disconnect();

      // Assert: Awareness removal arrived and state was removed immediately (in < 1000ms)
      await expect(removalPromise).resolves.toBeUndefined();

      socket2.disconnect();
    });

    it('handles multiple tabs for the same user without removing the second tab on first tab disconnect', async () => {
      const user = await registerAndLogin('MultiTab User', 'multitab@presence.dev');
      const peer = await registerAndLogin('Observer Peer', 'observer@presence.dev');

      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ title: 'Multi-Tab Isolation Doc' });
      const docId = docRes.body.data.document._id;

      await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ email: peer.user.email });

      // User opens Tab 1 and Tab 2
      const tab1Socket = createSocket(user.token);
      const tab2Socket = createSocket(user.token);
      const peerSocket = createSocket(peer.token);

      await Promise.all([
        new Promise<void>((resolve) => tab1Socket.on('connect', resolve)),
        new Promise<void>((resolve) => tab2Socket.on('connect', resolve)),
        new Promise<void>((resolve) => peerSocket.on('connect', resolve)),
      ]);

      await Promise.all([
        new Promise<void>((resolve) => tab1Socket.emit('join-document', { docId }, () => resolve())),
        new Promise<void>((resolve) => tab2Socket.emit('join-document', { docId }, () => resolve())),
        new Promise<void>((resolve) => peerSocket.emit('join-document', { docId }, () => resolve())),
      ]);

      // Tab 1 awareness
      const tab1Doc = new Y.Doc();
      const tab1Aw = new Awareness(tab1Doc);
      tab1Aw.setLocalState({ cursor: { anchor: 10, head: 10 } });
      const tab1Cid = tab1Aw.clientID;

      // Tab 2 awareness
      const tab2Doc = new Y.Doc();
      const tab2Aw = new Awareness(tab2Doc);
      tab2Aw.setLocalState({ cursor: { anchor: 20, head: 20 } });
      const tab2Cid = tab2Aw.clientID;

      const observerAw = new Awareness(new Y.Doc());
      peerSocket.on('awareness-update', (payload) => {
        applyAwarenessUpdate(observerAw, new Uint8Array(payload.update), 'remote');
      });

      tab1Socket.emit('awareness-update', {
        docId,
        update: Array.from(encodeAwarenessUpdate(tab1Aw, [tab1Cid])),
      });

      tab2Socket.emit('awareness-update', {
        docId,
        update: Array.from(encodeAwarenessUpdate(tab2Aw, [tab2Cid])),
      });

      // Wait until observer registers both tabs
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (observerAw.getStates().has(tab1Cid) && observerAw.getStates().has(tab2Cid)) {
            clearInterval(interval);
            resolve();
          }
        }, 20);
      });

      expect(observerAw.getStates().has(tab1Cid)).toBe(true);
      expect(observerAw.getStates().has(tab2Cid)).toBe(true);

      // Now close Tab 1 only
      tab1Socket.disconnect();

      // Wait for Tab 1 removal update
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (!observerAw.getStates().has(tab1Cid)) {
            clearInterval(interval);
            resolve();
          }
        }, 20);
      });

      // Tab 1 is gone, but Tab 2 is STILL active!
      expect(observerAw.getStates().has(tab1Cid)).toBe(false);
      expect(observerAw.getStates().has(tab2Cid)).toBe(true);

      tab2Socket.disconnect();
      peerSocket.disconnect();
    });

    it('ensures awareness data is never persisted as document content in MongoDB', async () => {
      const owner = await registerAndLogin('Owner Persist', 'owner.persist@security.dev');
      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Awareness Not Persisted Doc' });
      const docId = docRes.body.data.document._id;

      const socket = createSocket(owner.token);
      await new Promise<void>((resolve) => socket.on('connect', resolve));
      await new Promise<void>((resolve) => socket.emit('join-document', { docId }, () => resolve()));

      // Send document edit and await acknowledgment
      const clientDoc = new Y.Doc();
      clientDoc.getText('content').insert(0, 'Legitimate persisted content.');
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

      // Send lots of awareness updates
      const aw = new Awareness(clientDoc);
      for (let i = 0; i < 5; i++) {
        aw.setLocalState({ cursor: { anchor: i * 5, head: i * 5 } });
        socket.emit('awareness-update', {
          docId,
          update: Array.from(encodeAwarenessUpdate(aw, [aw.clientID])),
        });
      }

      // Flush to MongoDB
      await roomManager.flushPersistence(docId);

      // Inspect persisted state from MongoDB
      const dbDoc = await DocumentModel.findById(docId);
      expect(dbDoc?.contentBinary).toBeDefined();

      const restoredDoc = new Y.Doc();
      Y.applyUpdate(restoredDoc, new Uint8Array(dbDoc!.contentBinary!));

      // Assert document text is present
      expect(restoredDoc.getText('content').toString()).toBe('Legitimate persisted content.');

      // Assert Y.Doc contains zero awareness data
      expect((restoredDoc as any).awareness).toBeUndefined();
      expect(restoredDoc.share.size).toBe(1); // Only 'content' exists

      socket.disconnect();
    });

    it('safely handles and discards malformed awareness binary payloads without crashing server', async () => {
      const owner = await registerAndLogin('Robustness Tester', 'robust@security.dev');
      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Malformed Robustness Doc' });
      const docId = docRes.body.data.document._id;

      const socket = createSocket(owner.token);
      await new Promise<void>((resolve) => socket.on('connect', resolve));
      await new Promise<void>((resolve) => socket.emit('join-document', { docId }, () => resolve()));

      // Send corrupt binary buffer
      const junkBuffer = Buffer.from([0xff, 0xfe, 0x00, 0x12, 0x88, 0x99]);
      socket.emit('awareness-update', {
        docId,
        update: Array.from(junkBuffer),
      });

      // Send non-JSON awareness payload
      const nonJsonEncoder = encoding.createEncoder();
      encoding.writeVarUint(nonJsonEncoder, 1);
      encoding.writeVarUint(nonJsonEncoder, 12345);
      encoding.writeVarUint(nonJsonEncoder, 1);
      encoding.writeVarString(nonJsonEncoder, 'This is not JSON at all');
      socket.emit('awareness-update', {
        docId,
        update: Array.from(encoding.toUint8Array(nonJsonEncoder)),
      });

      await new Promise((r) => setTimeout(r, 100));

      // Assert server is still responsive and processes legitimate request
      const pingDoc = new Y.Doc();
      pingDoc.getText('content').insert(0, 'Server still healthy');
      const ack = await new Promise<any>((resolve) => {
        socket.emit(
          'document-update',
          { docId, update: Array.from(Y.encodeStateAsUpdate(pingDoc)) },
          resolve
        );
      });

      expect(ack.success).toBe(true);
      socket.disconnect();
    });
  });

  describe('Task 3: Reconnection and Revocation Races', () => {
    it('immediately evicts revoked collaborator, removes their cursor, rejects edits, and blocks reconnection', async () => {
      const owner = await registerAndLogin('Owner Eve', 'eve.owner@security.dev');
      const collab = await registerAndLogin('Collab Dave', 'dave.collab@security.dev');

      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Revocation Lifecycle Doc' });
      const docId = docRes.body.data.document._id;

      await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: collab.user.email });

      const ownerSocket = createSocket(owner.token);
      const collabSocket = createSocket(collab.token);

      await Promise.all([
        new Promise<void>((resolve) => ownerSocket.on('connect', resolve)),
        new Promise<void>((resolve) => collabSocket.on('connect', resolve)),
      ]);

      await Promise.all([
        new Promise<void>((resolve) => ownerSocket.emit('join-document', { docId }, () => resolve())),
        new Promise<void>((resolve) => collabSocket.emit('join-document', { docId }, () => resolve())),
      ]);

      // Collab sends cursor awareness
      const collabDoc = new Y.Doc();
      const collabAw = new Awareness(collabDoc);
      collabAw.setLocalState({ cursor: { anchor: 15, head: 15 } });
      const collabCid = collabAw.clientID;

      const ownerAw = new Awareness(new Y.Doc());
      ownerSocket.on('awareness-update', (payload) => {
        applyAwarenessUpdate(ownerAw, new Uint8Array(payload.update), 'remote');
      });

      collabSocket.emit('awareness-update', {
        docId,
        update: Array.from(encodeAwarenessUpdate(collabAw, [collabCid])),
      });

      // Wait until owner sees collab cursor
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (ownerAw.getStates().has(collabCid)) {
            clearInterval(interval);
            resolve();
          }
        }, 20);
      });
      expect(ownerAw.getStates().has(collabCid)).toBe(true);

      // Listen for ACCESS_REVOKED on collab socket
      const revokedPromise = new Promise<{ code: string; message: string }>((resolve) => {
        collabSocket.on('document-error', resolve);
      });

      // Listen for awareness removal on owner socket
      const cursorRemovedPromise = new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (!ownerAw.getStates().has(collabCid)) {
            clearInterval(interval);
            resolve();
          }
        }, 20);
      });

      // Owner revokes Dave via REST API
      const revokeRes = await request(app)
        .delete(`/api/documents/${docId}/collaborators/${collab.user.id}`)
        .set('Authorization', `Bearer ${owner.token}`);
      expect(revokeRes.status).toBe(200);

      // 1. Collaborator socket receives ACCESS_REVOKED
      const err = await revokedPromise;
      expect(err.code).toBe('ACCESS_REVOKED');

      // 2. Owner immediately sees collaborator cursor removed from screen
      await expect(cursorRemovedPromise).resolves.toBeUndefined();

      // 3. Stale collaborator socket attempts to send an edit -> rejected
      const staleEditDoc = new Y.Doc();
      staleEditDoc.getText('content').insert(0, 'Unauthorized edit after revocation');
      const editAck = await new Promise<any>((resolve) => {
        collabSocket.emit(
          'document-update',
          { docId, update: Array.from(Y.encodeStateAsUpdate(staleEditDoc)) },
          resolve
        );
      });
      expect(editAck.success).toBe(false);

      // 4. Stale collaborator attempts to trigger persistence flush -> rejected
      const flushAck = await new Promise<any>((resolve) => {
        collabSocket.emit('flush-document', { docId }, resolve);
      });
      expect(flushAck.success).toBe(false);

      // 5. Collaborator reconnects / emits join-document -> strictly rejected with FORBIDDEN
      const rejoinPromise = new Promise<any>((resolve) => {
        collabSocket.once('document-error', (rejErr) => resolve(rejErr));
      });
      collabSocket.emit('join-document', { docId });

      const rejoinErr = await rejoinPromise;
      expect(rejoinErr.code).toBe('FORBIDDEN');

      ownerSocket.disconnect();
      collabSocket.disconnect();
    });

    it('rejects joining when collaborator access is revoked during join operation', async () => {
      const owner = await registerAndLogin('Owner Zara', 'zara@security.dev');
      const guest = await registerAndLogin('Guest Frank', 'frank@security.dev');

      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Race During Join Doc' });
      const docId = docRes.body.data.document._id;

      // Add guest
      await request(app)
        .post(`/api/documents/${docId}/collaborators`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: guest.user.email });

      const guestSocket = createSocket(guest.token);
      await new Promise<void>((resolve) => guestSocket.on('connect', resolve));

      // Revoke guest right before join completes
      await request(app)
        .delete(`/api/documents/${docId}/collaborators/${guest.user.id}`)
        .set('Authorization', `Bearer ${owner.token}`);

      const errPromise = new Promise<any>((resolve) => {
        guestSocket.on('document-error', resolve);
      });

      guestSocket.emit('join-document', { docId });

      const err = await errPromise;
      expect(['FORBIDDEN', 'ACCESS_REVOKED']).toContain(err.code);

      // Verify guest socket was not added to roomManager
      expect(roomManager.hasSocket(docId, guestSocket.id)).toBe(false);

      guestSocket.disconnect();
    });

    it('survives repeated disconnects and reconnects without presence corruption', async () => {
      const user = await registerAndLogin('Rapid Reconnecter', 'rapid@security.dev');
      const docRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ title: 'Rapid Reconnect Doc' });
      const docId = docRes.body.data.document._id;

      for (let i = 0; i < 3; i++) {
        const sock = createSocket(user.token);
        await new Promise<void>((resolve) => sock.on('connect', resolve));
        await new Promise<void>((resolve) => sock.emit('join-document', { docId }, () => resolve()));

        expect(roomManager.hasSocket(docId, sock.id)).toBe(true);

        const testDoc = new Y.Doc();
        const testAw = new Awareness(testDoc);
        testAw.setLocalState({ cursor: { anchor: i, head: i } });
        sock.emit('awareness-update', {
          docId,
          update: Array.from(encodeAwarenessUpdate(testAw, [testAw.clientID])),
        });

        await new Promise((r) => setTimeout(r, 50));

        sock.disconnect();
        await new Promise((r) => setTimeout(r, 50));

        expect(roomManager.hasSocket(docId, sock.id)).toBe(false);
      }
    });
  });
});

import http from 'http';
import mongoose from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';
import { io as ClientSocket } from 'socket.io-client';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';
import jwt from 'jsonwebtoken';
import { createApp } from '../server/dist/app.js';
import { registerSocketHandlers } from '../server/dist/sockets/socketHandler.js';
import { roomManager } from '../server/dist/sockets/roomManager.js';
import { DocumentModel } from '../server/dist/models/Document.js';
import { User } from '../server/dist/models/User.js';
import { generateToken } from '../server/dist/middleware/auth.js';

const MONGO_URI = 'mongodb://127.0.0.1:27017/collabsync';

function makeToken(user) {
  return generateToken({
    id: user._id.toString(),
    email: user.email,
    name: user.name,
  });
}

async function runLiveVerification() {
  console.log('--- Phase 2.2 Live MongoDB Security & Presence Verification ---');
  await mongoose.connect(MONGO_URI);
  console.log('Connected to live MongoDB at', MONGO_URI);

  const app = createApp();
  const server = http.createServer(app);
  const ioServer = new SocketIOServer(server, { transports: ['websocket'] });
  registerSocketHandlers(ioServer);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log('Ephemeral Socket.IO server listening on port', port);

  function createClient(token) {
    return ClientSocket(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
  }

  try {
    console.log('Step 1: Creating users...');
    const testSuffix = Date.now();
    const aliceUser = await User.create({
      name: 'Alice Live',
      email: `alice_${testSuffix}@live.test`,
      password: 'Password123!',
    });
    console.log('Alice user created:', aliceUser._id);
    const bobUser = await User.create({
      name: 'Bob Live',
      email: `bob_${testSuffix}@live.test`,
      password: 'Password123!',
    });
    console.log('Bob user created:', bobUser._id);

    const aliceToken = makeToken(aliceUser);
    const bobToken = makeToken(bobUser);

    console.log('Step 2: Creating document...');
    const liveDoc = await DocumentModel.create({
      title: `Live Hardening Doc ${testSuffix}`,
      owner: aliceUser._id,
      collaborators: [bobUser._id],
    });
    const docId = liveDoc._id.toString();
    console.log('Doc created:', docId);

    console.log('Step 3: Connecting sockets...');
    const aliceSocket = createClient(aliceToken);
    const bobSocket = createClient(bobToken);

    await Promise.all([
      new Promise((resolve, reject) => {
        if (aliceSocket.connected) resolve();
        else {
          aliceSocket.once('connect', resolve);
          aliceSocket.once('connect_error', (err) => reject(new Error('Alice connect error: ' + err.message)));
        }
      }),
      new Promise((resolve, reject) => {
        if (bobSocket.connected) resolve();
        else {
          bobSocket.once('connect', resolve);
          bobSocket.once('connect_error', (err) => reject(new Error('Bob connect error: ' + err.message)));
        }
      }),
    ]);
    console.log('Sockets connected. Joining document...');

    await Promise.all([
      new Promise((resolve) => aliceSocket.emit('join-document', { docId }, resolve)),
      new Promise((resolve) => bobSocket.emit('join-document', { docId }, resolve)),
    ]);
    console.log('[PASS] Alice and Bob successfully authenticated and joined room');

    // 4. Bob attempts to spoof awareness payload (claiming to be superadmin Alice)
    const bobDoc = new Y.Doc();
    const bobAw = new Awareness(bobDoc);
    bobAw.setLocalState({
      user: {
        id: aliceUser._id.toString(),
        name: 'Alice Live Spoofed',
        email: 'alice.spoofed@admin.com',
        role: 'superadmin',
      },
      cursor: { anchor: 99, head: 99 },
    });

    const aliceReceivedAwPromise = new Promise((resolve) => {
      aliceSocket.on('awareness-update', (payload) => {
        const testAw = new Awareness(new Y.Doc());
        applyAwarenessUpdate(testAw, new Uint8Array(payload.update), 'test');
        resolve(testAw.getStates().get(bobAw.clientID));
      });
    });

    bobSocket.emit('awareness-update', {
      docId,
      update: Array.from(encodeAwarenessUpdate(bobAw, [bobAw.clientID])),
    });

    const bobSanitizedState = await aliceReceivedAwPromise;
    console.log('Alice received Bob awareness state:', JSON.stringify(bobSanitizedState));

    if (bobSanitizedState.user.name !== 'Bob Live' || bobSanitizedState.user.id !== bobUser._id.toString()) {
      throw new Error(`Impersonation check FAILED: expected Bob Live, got ${bobSanitizedState.user.name}`);
    }
    if (bobSanitizedState.user.email || bobSanitizedState.user.role) {
      throw new Error('Sensitive data stripping check FAILED: email/role leaked in awareness update');
    }
    console.log('[PASS] Awareness sanitization enforced server-side identity and stripped sensitive fields');

    // 5. Test multi-tab isolation: Bob opens Tab 2
    const bobTab2Socket = createClient(bobToken);
    await new Promise((resolve) => bobTab2Socket.on('connect', resolve));
    await new Promise((resolve) => bobTab2Socket.emit('join-document', { docId }, resolve));

    const bobTab2Doc = new Y.Doc();
    const bobTab2Aw = new Awareness(bobTab2Doc);
    bobTab2Aw.setLocalState({ cursor: { anchor: 200, head: 200 } });

    const aliceAwTracker = new Awareness(new Y.Doc());
    aliceSocket.on('awareness-update', (payload) => {
      applyAwarenessUpdate(aliceAwTracker, new Uint8Array(payload.update), 'test');
    });

    // Both Tab 1 and Tab 2 emit awareness updates
    bobSocket.emit('awareness-update', {
      docId,
      update: Array.from(encodeAwarenessUpdate(bobAw, [bobAw.clientID])),
    });

    bobTab2Socket.emit('awareness-update', {
      docId,
      update: Array.from(encodeAwarenessUpdate(bobTab2Aw, [bobTab2Aw.clientID])),
    });

    // Wait until Alice receives both of Bob's tabs
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (aliceAwTracker.getStates().has(bobAw.clientID) && aliceAwTracker.getStates().has(bobTab2Aw.clientID)) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    // Bob closes Tab 1
    bobSocket.disconnect();

    // Verify Tab 1 is removed from Alice's awareness, while Tab 2 stays alive
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (!aliceAwTracker.getStates().has(bobAw.clientID)) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    if (!aliceAwTracker.getStates().has(bobTab2Aw.clientID)) {
      throw new Error('Multi-tab check FAILED: Tab 2 presence was erroneously wiped when Tab 1 closed');
    }
    console.log('[PASS] Multi-tab awareness isolation verified on live MongoDB & Socket.IO');

    // 6. Test Collaborator Revocation
    // Alice removes Bob from collaborators in MongoDB and triggers revocation
    liveDoc.collaborators = [];
    await liveDoc.save();

    // Import revokeUserFromRoom
    const { revokeUserFromRoom } = await import('../server/dist/sockets/socketHandler.js');
    revokeUserFromRoom(docId, bobUser._id.toString());

    // Bob Tab 2 attempts to send edit -> must fail
    const rejectedEditDoc = new Y.Doc();
    rejectedEditDoc.getText('content').insert(0, 'Unauthorized edit after revocation');
    const editAck = await new Promise((resolve) => {
      bobTab2Socket.emit(
        'document-update',
        { docId, update: Array.from(Y.encodeStateAsUpdate(rejectedEditDoc)) },
        resolve
      );
    });

    if (editAck.success !== false) {
      throw new Error('Revocation enforcement FAILED: revoked socket edit was accepted');
    }
    console.log('[PASS] Stale socket edit rejected after access revocation');

    // 7. Test persistence integrity: ensure awareness is never in MongoDB contentBinary
    const aliceDoc = new Y.Doc();
    aliceDoc.getText('content').insert(0, 'Authentic document text from Alice');
    await new Promise((resolve) => {
      aliceSocket.emit(
        'document-update',
        { docId, update: Array.from(Y.encodeStateAsUpdate(aliceDoc)) },
        resolve
      );
    });

    await roomManager.flushPersistence(docId);

    const persistedDoc = await DocumentModel.findById(docId);
    if (!persistedDoc.contentBinary) {
      throw new Error('Persistence FAILED: contentBinary is null');
    }

    const inspectionDoc = new Y.Doc();
    Y.applyUpdate(inspectionDoc, new Uint8Array(persistedDoc.contentBinary));
    const persistedText = inspectionDoc.getText('content').toString();
    console.log('Persisted MongoDB text:', persistedText);

    if (persistedText !== 'Authentic document text from Alice') {
      throw new Error(`Persisted text mismatch: expected "Authentic document text from Alice", got "${persistedText}"`);
    }

    // Clean up
    aliceSocket.disconnect();
    bobTab2Socket.disconnect();
    await User.deleteMany({ _id: { $in: [aliceUser._id, bobUser._id] } });
    await DocumentModel.deleteOne({ _id: docId });

    console.log('--- ALL LIVE SECURITY & PRESENCE VERIFICATIONS PASSED ---');
  } finally {
    await new Promise((resolve) => ioServer.close(() => server.close(resolve)));
    await mongoose.disconnect();
  }
}

runLiveVerification().catch((err) => {
  console.error('LIVE VERIFICATION ERROR:', err);
  process.exit(1);
});

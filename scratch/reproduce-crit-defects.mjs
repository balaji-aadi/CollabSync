import { createRequire } from 'module';
const require = createRequire('/Users/balajiaadesh/Desktop/projects/CollabSync/server/package.json');
const Y = require('yjs');
const mongoose = require('mongoose');

// Import from compiled or ts-node/tsx server
const { roomManager } = await import('../server/src/sockets/roomManager.js');
const { DocumentModel } = await import('../server/src/models/Document.js');
const { connectDatabase, disconnectDatabase } = await import('../server/src/config/database.js');

async function testReproduce() {
  console.log('=== Reproducing CRIT-01 and CRIT-02 on Current Code ===\n');
  await connectDatabase('mongodb://127.0.0.1:27017/collabsync');

  // --- REPRODUCE CRIT-02: matchedCount: 0 falsely reports saved ---
  console.log('--- Testing CRIT-02: Persistence on Non-Existent Document ---');
  const fakeDocId = new mongoose.Types.ObjectId().toString();
  const room2 = roomManager.getOrCreateRoom(fakeDocId);
  room2.isInitialized = true;
  roomManager.applyUpdate(fakeDocId, Y.encodeStateAsUpdate(new Y.Doc()));

  let lastSaveStatus = null;
  const unsubscribe = roomManager.onSaveStatus((docId, status) => {
    if (docId === fakeDocId) {
      lastSaveStatus = status;
    }
  });

  const saveResult = await roomManager.flushPersistence(fakeDocId);
  unsubscribe();
  console.log('CRIT-02: flushPersistence returned:', saveResult);
  console.log('CRIT-02: save-status event emitted:', lastSaveStatus);

  if (saveResult === true && lastSaveStatus === 'saved') {
    console.log('❌ CRIT-02 REPRODUCED: Persistence falsely claimed SUCCESS on a non-existent document!\n');
  } else {
    console.log('CRIT-02 not reproduced: saveResult =', saveResult, 'status =', lastSaveStatus);
  }

  // --- REPRODUCE CRIT-01: Eviction destroys active room upon reconnect during flush ---
  console.log('--- Testing CRIT-01: Eviction Flush Race Condition ---');
  // Create a real doc in DB
  const realDoc = await DocumentModel.create({
    title: 'Eviction Race Test',
    owner: new mongoose.Types.ObjectId(),
    contentBinary: null,
  });
  const docId = realDoc._id.toString();

  // Set very short idle timeout for testing
  roomManager.setIdleTimeout(50);

  // User 1 joins and adds content
  roomManager.addSocket(docId, 'socket-user-1');
  const docInit = new Y.Doc();
  docInit.getText('content').insert(0, 'Initial content before leave.');
  roomManager.applyUpdate(docId, Y.encodeStateAsUpdate(docInit));

  // Intercept DocumentModel.updateOne to artificially introduce a delay during the eviction flush
  const originalUpdateOne = DocumentModel.updateOne;
  let delayFlushResolve = null;
  const flushPausePromise = new Promise((resolve) => {
    delayFlushResolve = resolve;
  });

  let updateOneCalled = false;
  DocumentModel.updateOne = async function (...args) {
    updateOneCalled = true;
    console.log('-> [Mock Hook] DocumentModel.updateOne paused in flight...');
    await flushPausePromise;
    console.log('-> [Mock Hook] Resuming DocumentModel.updateOne');
    return originalUpdateOne.apply(this, args);
  };

  // User 1 leaves, activeSockets drops to 0 -> triggers eviction timeout
  console.log('1. User 1 leaves room (activeSockets becomes 0)');
  roomManager.removeSocket(docId, 'socket-user-1');

  // Wait for eviction timer to fire and pause inside DocumentModel.updateOne
  await new Promise((r) => {
    const check = () => {
      if (updateOneCalled) return r();
      setTimeout(check, 10);
    };
    check();
  });
  console.log('2. Eviction flush started and is currently awaiting MongoDB...');

  // While flush is awaiting Mongo, User 2 reconnects!
  console.log('3. User 2 connects, joins room, and edits content while flush is paused');
  const reconnectedRoom = roomManager.addSocket(docId, 'socket-user-2');
  const user2Doc = new Y.Doc();
  user2Doc.getText('content').insert(0, ' New edit from User 2');
  roomManager.applyUpdate(docId, Y.encodeStateAsUpdate(user2Doc));

  console.log('   User 2 activeSockets count:', reconnectedRoom.activeSockets.size);
  console.log('   User 2 ydoc.isDestroyed before flush resumes:', reconnectedRoom.ydoc.isDestroyed ?? false);

  // Now let the eviction flush complete
  console.log('4. Releasing paused flush to finish...');
  delayFlushResolve();

  // Give event loop a tick to process the eviction callback post-await lines
  await new Promise((r) => setTimeout(r, 100));

  // Restore original updateOne
  DocumentModel.updateOne = originalUpdateOne;

  console.log('5. Inspecting room state after eviction callback completed:');
  console.log('   roomManager.hasRoom(docId):', roomManager.hasRoom(docId));
  console.log('   reconnectedRoom.ydoc destroyed?:', reconnectedRoom.ydoc.isDestroyed || (reconnectedRoom.ydoc._item === null));
  
  let crashed = false;
  try {
    reconnectedRoom.ydoc.getText('content').toString();
    // Try to apply another update to the destroyed ydoc
    Y.applyUpdate(reconnectedRoom.ydoc, Y.encodeStateAsUpdate(new Y.Doc()));
  } catch (err) {
    crashed = true;
    console.log('   Attempt to use ydoc threw error:', err.message);
  }

  if (!roomManager.hasRoom(docId) || crashed) {
    console.log('❌ CRIT-01 REPRODUCED: Eviction destroyed active room / evicted it from memory despite User 2 being active!\n');
  } else {
    console.log('CRIT-01 not reproduced.');
  }

  // Cleanup
  await DocumentModel.deleteOne({ _id: realDoc._id });
  await disconnectDatabase();
}

testReproduce().catch(err => {
  console.error(err);
  process.exit(1);
});

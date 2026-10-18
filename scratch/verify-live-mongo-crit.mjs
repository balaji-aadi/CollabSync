import { createRequire } from 'module';
const require = createRequire('/Users/balajiaadesh/Desktop/projects/CollabSync/server/package.json');
const Y = require('yjs');
const mongoose = require('mongoose');

const { roomManager } = await import('../server/src/sockets/roomManager.js');
const { DocumentModel } = await import('../server/src/models/Document.js');
const { connectDatabase, disconnectDatabase } = await import('../server/src/config/database.js');

const MONGO_URI = 'mongodb://127.0.0.1:27017/collabsync';

async function runLiveMongoVerification() {
  console.log('=== Verifying CRIT-01 and CRIT-02 Against Live MongoDB 7.0 Container ===\n');
  await connectDatabase(MONGO_URI);
  console.log('✓ Connected to MongoDB 7.0 container on port 27017\n');

  // =========================================================================
  // TEST 1: CRIT-02 Verification on Real MongoDB Container
  // =========================================================================
  console.log('--- Test 1: CRIT-02 on Real MongoDB 7.0 Container ---');
  // 1a. Real document exists -> save must return true and emit 'saved'
  const realDoc = await DocumentModel.create({
    title: 'CRIT-02 Live Mongo Test Doc',
    owner: new mongoose.Types.ObjectId(),
    contentBinary: null,
  });
  const docId = realDoc._id.toString();

  const realRoom = roomManager.getOrCreateRoom(docId);
  realRoom.isInitialized = true;
  const initDoc = new Y.Doc();
  initDoc.getText('content').insert(0, 'Real Mongo persistence check');
  roomManager.applyUpdate(docId, Y.encodeStateAsUpdate(initDoc));

  let receivedStatus = null;
  let unsub = roomManager.onSaveStatus((dId, status) => {
    if (dId === docId) receivedStatus = status;
  });

  const saveSuccess = await roomManager.flushPersistence(docId);
  unsub();

  console.log('1a. Real Document: flushPersistence returned:', saveSuccess);
  console.log('1a. Real Document: save-status emitted:', receivedStatus);
  if (!saveSuccess || receivedStatus !== 'saved') {
    throw new Error('FAILED: Real document save did not produce true and "saved"');
  }

  // 1b. Document deleted from real MongoDB -> save must return false and emit 'error'
  await DocumentModel.deleteOne({ _id: realDoc._id });
  console.log('1b. Document deleted from MongoDB container');

  // Add another edit to mark dirty
  const updateDoc = new Y.Doc();
  updateDoc.getText('content').insert(0, 'More content on deleted doc');
  roomManager.applyUpdate(docId, Y.encodeStateAsUpdate(updateDoc));

  let errorStatus = null;
  let errorMsg = null;
  let hadSaved = false;
  unsub = roomManager.onSaveStatus((dId, status, _, err) => {
    if (dId === docId) {
      if (status === 'saved') hadSaved = true;
      if (status === 'error') {
        errorStatus = status;
        errorMsg = err;
      }
    }
  });

  const failResult = await roomManager.flushPersistence(docId);
  unsub();

  console.log('1b. Deleted Document: flushPersistence returned:', failResult);
  console.log('1b. Deleted Document: save-status emitted:', errorStatus);
  console.log('1b. Deleted Document: error details:', errorMsg);
  console.log('1b. Deleted Document: was "saved" ever emitted?:', hadSaved);
  console.log('1b. Deleted Document: room.dirty preserved?:', roomManager.isDirty(docId));

  if (failResult !== false || errorStatus !== 'error' || hadSaved || !roomManager.isDirty(docId)) {
    throw new Error('FAILED: CRIT-02 check failed on real MongoDB container!');
  }
  console.log('✅ CRIT-02 VERIFIED ON REAL MONGODB CONTAINER!\n');

  // =========================================================================
  // TEST 2: CRIT-01 Verification on Real MongoDB Container
  // =========================================================================
  console.log('--- Test 2: CRIT-01 Race on Real MongoDB 7.0 Container ---');
  const raceDoc = await DocumentModel.create({
    title: 'CRIT-01 Live Race Doc',
    owner: new mongoose.Types.ObjectId(),
    contentBinary: null,
  });
  const raceDocId = raceDoc._id.toString();

  roomManager.setIdleTimeout(20);

  // User 1 joins and adds edits
  roomManager.addSocket(raceDocId, 'socket-live-1');
  const rDoc1 = new Y.Doc();
  rDoc1.getText('content').insert(0, 'First user live edit. ');
  roomManager.applyUpdate(raceDocId, Y.encodeStateAsUpdate(rDoc1));

  // Pause updateOne in flight during eviction
  const originalUpdateOne = DocumentModel.updateOne;
  let resumeFlush = () => {};
  const pausePromise = new Promise((r) => { resumeFlush = r; });
  let flushStarted = () => {};
  const startedPromise = new Promise((r) => { flushStarted = r; });

  DocumentModel.updateOne = async function (...args) {
    flushStarted();
    await pausePromise;
    return originalUpdateOne.apply(this, args);
  };

  try {
    // User 1 leaves -> triggers eviction timer
    console.log('2a. User 1 leaves (activeSockets -> 0)');
    roomManager.removeSocket(raceDocId, 'socket-live-1');

    await startedPromise;
    console.log('2b. Eviction flush started and is paused in flight...');

    // User 2 joins while flush is paused
    console.log('2c. User 2 connects, joins room, and edits while flush is paused');
    const user2Room = roomManager.addSocket(raceDocId, 'socket-live-2');
    const rDoc2 = new Y.Doc();
    rDoc2.getText('content').insert(0, 'Second user edit while flush was paused. ');
    roomManager.applyUpdate(raceDocId, Y.encodeStateAsUpdate(rDoc2));

    console.log('    user2Room activeSockets:', user2Room.activeSockets.size);

    // Resume flush
    console.log('2d. Resuming paused flush to MongoDB container...');
    resumeFlush();

    // Allow event loop ticks for eviction callback post-await lines
    await new Promise((r) => setTimeout(r, 60));

    console.log('2e. Verifying room state:');
    console.log('    roomManager.hasRoom:', roomManager.hasRoom(raceDocId));
    console.log('    activeSockets:', user2Room.activeSockets.size);

    if (!roomManager.hasRoom(raceDocId)) {
      throw new Error('FAILED: Active room was destroyed by eviction callback!');
    }

    // Subsequent edit by User 2
    const rDoc3 = new Y.Doc();
    rDoc3.getText('content').insert(0, 'Third edit after flush completed. ');
    roomManager.applyUpdate(raceDocId, Y.encodeStateAsUpdate(rDoc3));

    // Flush to real MongoDB container
    const finalFlushSuccess = await roomManager.flushPersistence(raceDocId);
    console.log('2f. Final flush success to MongoDB container:', finalFlushSuccess);

    // Read directly from real MongoDB BSON
    const finalDbDoc = await DocumentModel.findById(raceDocId);
    const decodedFinalDoc = new Y.Doc();
    Y.applyUpdate(decodedFinalDoc, new Uint8Array(finalDbDoc.contentBinary));
    const fullText = decodedFinalDoc.getText('content').toString();

    console.log('2g. Full text restored from MongoDB container BSON:\n   ', JSON.stringify(fullText));

    if (
      !fullText.includes('First user live edit.') ||
      !fullText.includes('Second user edit while flush was paused.') ||
      !fullText.includes('Third edit after flush completed.')
    ) {
      throw new Error('FAILED: Edits were lost during eviction race!');
    }

    console.log('✅ CRIT-01 VERIFIED ON REAL MONGODB CONTAINER!\n');
    roomManager.removeSocket(raceDocId, 'socket-live-2');
  } finally {
    DocumentModel.updateOne = originalUpdateOne;
    await DocumentModel.deleteOne({ _id: raceDoc._id });
  }

  await disconnectDatabase();
  console.log('=== ALL LIVE MONGODB CONTAINER CHECKS PASSED SUCCESSFULLY ===');
}

runLiveMongoVerification().catch((err) => {
  console.error('Live verification failed:', err);
  process.exit(1);
});

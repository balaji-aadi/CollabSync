# CollabSync — Phase 2.1: Critical Concurrency & Persistence Remediation Report

> **Remediation Date:** 2026-10-18  
> **Target Milestone:** Phase 2.1 — Critical Concurrency & Persistence Remediation  
> **Target Branch:** `main`  
> **Status:** **READY FOR MANUAL TESTING**  
> **Automated Test Results:** 49/49 tests passing across 7 suites in Vitest (43 baseline + 6 new regression tests)  
> **Build Status:** 0 TypeScript compilation errors (`tsc --noEmit`, `tsc` build passed)  

---

## 1. Executive Summary

This remediation report documents the surgical fixes applied to resolve the two critical vulnerabilities identified during the independent Phase 2 audit:

1. **CRIT-01 (Idle Eviction Concurrency Race):** An eviction flush race condition where an incoming socket connection or reconnection occurring while `flushPersistence` awaited MongoDB I/O caused the subsequent eviction callback to destroy the newly active room's `Y.Doc` and evict it from memory.
2. **CRIT-02 (False-Positive Persistence Success):** `DocumentModel.updateOne` return value was not inspected for `matchedCount`, causing persistence on missing or deleted documents to falsely return `success: true` and emit `save-status: 'saved'`.

Both defects were reproduced deterministically prior to patching, corrected using minimal, race-free state validations, and proven resolved via dedicated automated regression tests.

---

## 2. Detailed Defect Analysis & Root Causes

### 2.1 CRIT-01: Idle Eviction Race Condition
- **Location:** `server/src/sockets/roomManager.ts:185-197`
- **Root Cause:**
  When all active sockets left a room, `removeSocket` set an eviction timeout (`this.idleTimers.set(docId, timer)`). When the timer fired, it checked `if (currentRoom && currentRoom.activeSockets.size === 0)` and invoked `await this.flushPersistence(docId)`.
  Because `flushPersistence` performs asynchronous network I/O to MongoDB, execution suspended. During this suspension window:
  1. A user reconnected or joined via `getOrCreateRoom(docId)`.
  2. The room was retrieved from `this.rooms`, the new socket was added (`activeSockets.size > 0`), and the client began typing.
  3. When `flushPersistence` finished, the callback resumed and executed `currentRoom.ydoc.destroy()` and `this.rooms.delete(docId)` without re-checking whether new sockets had joined or if the room had become active again.
  4. The active client's in-memory `Y.Doc` was destroyed mid-flight, causing future edits to fail and unpersisted edits to be lost.

### 2.2 CRIT-02: False-Positive Persistence Success
- **Location:** `server/src/sockets/roomManager.ts:277-293`
- **Root Cause:**
  `flushPersistence` called `await DocumentModel.updateOne({ _id: docId }, { $set: ... })`.
  In MongoDB driver / Mongoose semantics, `updateOne` does not throw an error if no document matches the `_id` filter; it returns `{ acknowledged: true, matchedCount: 0, modifiedCount: 0 }`.
  Because `result.matchedCount` was not validated, `flushPersistence` marked `room.dirty = false`, updated `room.lastSavedAt`, notified `save-status: 'saved'`, and returned `true`.
  Clients were falsely told that their document was saved to MongoDB when in fact 0 documents were updated.

---

## 3. Exact Code Changes Made

### 3.1 `server/src/sockets/roomManager.ts`

#### Fix for CRIT-01 (`removeSocket`):
```ts
// server/src/sockets/roomManager.ts:184-239
if (room.activeSockets.size === 0 && !this.idleTimers.has(docId)) {
  const timer = setTimeout(async () => {
    // 1. Verify timer is still active and registered for this document
    if (this.idleTimers.get(docId) !== timer) {
      return;
    }

    const currentRoom = this.rooms.get(docId);
    if (!currentRoom || currentRoom.activeSockets.size > 0) {
      this.idleTimers.delete(docId);
      return;
    }

    // 2. Ensure pending dirty state is committed to MongoDB before destroying room
    if (currentRoom.dirty) {
      try {
        await this.flushPersistence(docId);
      } catch (err: any) {
        console.error(`[RoomManager] Error flushing before eviction for ${docId}:`, err.message);
      }
    }

    // 3. CRITICAL POST-AWAIT RE-CHECKS (CRIT-01):
    // Re-verify room instance, timer identity, and active socket count after MongoDB I/O
    if (
      this.rooms.get(docId) !== currentRoom ||
      this.idleTimers.get(docId) !== timer ||
      currentRoom.activeSockets.size > 0
    ) {
      // Room is active or was re-acquired during flush; ABORT eviction
      if (this.idleTimers.get(docId) === timer) {
        this.idleTimers.delete(docId);
      }
      return;
    }

    // 4. If new edits arrived during the flush that left the room dirty, abort eviction and reschedule
    if (currentRoom.dirty) {
      this.idleTimers.delete(docId);
      if (currentRoom.activeSockets.size === 0) {
        this.removeSocket(docId, '');
      }
      return;
    }

    // 5. Atomic unregister before destroying internal instances
    this.idleTimers.delete(docId);
    this.rooms.delete(docId);
    currentRoom.awareness.destroy();
    currentRoom.ydoc.destroy();
  }, this.idleTimeoutMs);
  this.idleTimers.set(docId, timer);
}
```

#### Fix for CRIT-02 (`flushPersistence`):
```ts
// server/src/sockets/roomManager.ts:275-300
const now = new Date();
const result = await DocumentModel.updateOne(
  { _id: docId },
  {
    $set: {
      contentBinary: Buffer.from(snapshot),
      lastSavedAt: now,
    },
  },
  { writeConcern: { w: 'majority' } }
);

// Explicitly assert that the write was acknowledged and matched a document in MongoDB
if (!result.acknowledged || result.matchedCount === 0) {
  throw new Error(
    `Document ${docId} persistence unacknowledged or not found in database (matchedCount: ${result.matchedCount})`
  );
}

room.lastSavedAt = now;
```

#### Safe Cleanup in `destroyRoom`:
```ts
// server/src/sockets/roomManager.ts:365-375
const room = this.rooms.get(docId);
if (room) {
  if (room.dirty) {
    await this.flushPersistence(docId);
  }
  if (this.rooms.get(docId) === room) {
    this.rooms.delete(docId);
  }
  room.awareness.destroy();
  room.ydoc.destroy();
}
```

---

## 4. Regression Test Suite Added

A new deterministic test suite was added at `server/tests/crit-remediation.test.ts` (6 tests).

| Test Name | Defect Covered | What the Test Proves |
|---|---|---|
| `aborts eviction and preserves active Y.Doc when a client rejoins while flush is paused` | **CRIT-01** | Intercepts `DocumentModel.updateOne` with a controllable deferred promise to pause eviction flush in flight. While paused, a second user joins and edits. When the flush resumes, asserts that `roomManager.hasRoom(docId)` remains `true`, the active `Y.Doc` is NOT destroyed, subsequent edits succeed, and all edits persist to MongoDB. |
| `safely evicts room when no clients rejoin during eviction` | **CRIT-01** | Asserts the normal eviction path: dirty room flushes to DB, is removed from memory (`hasRoom === false`), and reconstitutes cleanly when reopened. |
| `persists and reports saved status when document is matched (matchedCount: 1)` | **CRIT-02** | Confirms normal save flow: `flushPersistence` returns `true`, `roomManager.isDirty` becomes `false`, and `save-status: 'saved'` is emitted. |
| `rejects persistence and preserves dirty state when document is missing (matchedCount: 0)` | **CRIT-02** | Targets a non-existent document ID: asserts `flushPersistence` returns `false`, `isDirty` remains `true`, `save-status: 'error'` is emitted with `matchedCount: 0`, and `save-status: 'saved'` is NEVER emitted. |
| `rejects persistence and preserves dirty state when database operation throws` | **CRIT-02** | Mocks `DocumentModel.updateOne` rejection: asserts `flushPersistence` returns `false`, room remains dirty, `save-status: 'error'` is emitted, and `saved` is never emitted. |
| `proves a failed persistence operation never emits a false saved status` | **CRIT-02** | Deletes a document from MongoDB behind RoomManager's back: asserts failure return, `error` status emitted, and zero false `saved` events across the lifecycle. |

---

## 5. Verification Commands and Actual Results

### 5.1 Targeted Regression Suite
```bash
$ npx vitest run tests/crit-remediation.test.ts
✓ tests/crit-remediation.test.ts (6 tests) 2093ms
  ✓ CRIT-01: aborts eviction and preserves active Y.Doc when a client rejoins while flush is paused (431ms)
  ✓ CRIT-01: safely evicts room when no clients rejoin during eviction (285ms)
  ✓ CRIT-02: persists and reports saved status when document is matched (matchedCount: 1) (129ms)
  ✓ CRIT-02: rejects persistence and preserves dirty state when document is missing (matchedCount: 0) (6ms)
  ✓ CRIT-02: rejects persistence and preserves dirty state when database operation throws (124ms)
  ✓ CRIT-02: proves a failed persistence operation never emits a false saved status (125ms)

Test Files  1 passed (1)
     Tests  6 passed (6)
  Duration  3.32s
```

### 5.2 Full Workspace Test Suite
```bash
$ npm run test
 RUN  v3.2.7 /Users/balajiaadesh/Desktop/projects/CollabSync/server
 ✓ tests/yjs-convergence.test.ts (4 tests) 21ms
 ✓ tests/e2e-smoke.test.ts (1 test) 3088ms
 ✓ tests/crit-remediation.test.ts (6 tests) 2936ms
 ✓ tests/auth.test.ts (11 tests) 2940ms
 ✓ tests/documents.test.ts (10 tests) 4596ms
 ✓ tests/socket.test.ts (10 tests) 5128ms
 ✓ tests/persistence-awareness.test.ts (7 tests) 5422ms

 Test Files  7 passed (7)
      Tests  49 passed (49)
   Duration  6.84s
```

### 5.3 Typecheck & Compilation
```bash
$ npm run typecheck
> collabsync@0.1.0 typecheck
> npm run typecheck --workspace=server && npm run typecheck --workspace=client
> collabsync-server@0.1.0 typecheck
> tsc --noEmit
> collabsync-client@0.1.0 typecheck
> tsc --noEmit

$ npm run build:server
> collabsync-server@0.1.0 build
> tsc
```
Result: **0 errors**.

---

## 6. Git Working-Tree Integrity

```bash
$ git status
On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  modified:   README.md

Untracked files:
  .env.example
  .gitignore
  .nvmrc
  client/
  docker-compose.yml
  docs/
  package-lock.json
  package.json
  scratch/
  server/
```
- Existing user modifications to `README.md` and untracked files remain untouched.
- No branches switched; no commits, merges, or pushes performed.

---

## 7. Remaining Scope (Out of Scope for Phase 2.1)

Per instructions, the following items remain slated for subsequent phases:
- **Phase 2.2 (Security & Presence):** HIGH-01 awareness identity validation (preventing cursor spoofing) and HIGH-02 immediate cursor cleanup on disconnect/revocation.
- **Phase 2.3 (Reliability Polish):** MED-01 `maxWait` debounce ceiling, MED-02 multi-instance OCC consideration, and LOW-01 redundant initial-state omission.

---

## 8. Final Status

**Status:** `READY FOR MANUAL TESTING`  
Phase 2.1 critical remediation is complete, verified, and ready for review.

# CollabSync — Phase 2 Independent Reliability, Security & Data-Loss Audit

> **Audit Date:** 2026-10-18  
> **Auditor:** Independent Lead Security & Reliability Engineer (Pair Programming Agent)  
> **Target Branch:** `main`  
> **Runtime Environment:** Node.js `v22.14.0` LTS, npm `10.9.2`, MongoDB `7.0` (Docker Container `collabsync-mongodb` on port `27017`), Vitest `3.2.7`  
> **Status:** **CONDITIONAL HOLD — Remediation Plan Required Prior to Phase 3**  
> **Automated Test Suite Status:** 43/43 tests passing in Vitest (`mongodb-memory-server`)  
> **Live Runtime Verification:** Verified against active daemon on `http://localhost:5005` with real MongoDB 7.0 container  

---

## 1. Executive Summary

This independent audit conducted a comprehensive, adversarial review of the completed Phase 2 implementation of **CollabSync**. The audit evaluated the system's claims regarding durable binary persistence, crash/restart recovery, Yjs two-step synchronization, ephemeral collaborator awareness, and real-time save-status reporting.

### Core Audit Verdict:
1. **The Core Architectural Direction Is Sound:**
   - The compaction and storage of Yjs CRDT binary updates (`Y.encodeStateAsUpdate`) into MongoDB BSON `BinData` is robust and correctly avoids fragile HTML/JSON conversions.
   - Genuine server process restarts and crash recovery were independently proven against a real MongoDB 7.0 instance: pre-restart edits were fully reconstituted upon process reboot.
   - The Yjs 2-step synchronization protocol successfully exchanges differential state vectors and merges concurrent local/remote edits without data duplication.
2. **Critical Vulnerabilities & Reliability Defects Discovered:**
   - **Critical Eviction Flush Race Condition (`roomManager.ts:185-197`):** When an idle room is being flushed before memory eviction, an asynchronous delay during `await this.flushPersistence(docId)` creates a race window. If a user connects or reconnects during this window, the callback subsequently executes `currentRoom.ydoc.destroy()` and deletes the room from memory, destroying the active user's session mid-flight.
   - **Critical Silent Persistence False-Positive (`roomManager.ts:277-293`):** `DocumentModel.updateOne` does not check `result.matchedCount`. If an active document is deleted from MongoDB, persistence calls report `{ success: true }` and broadcast `save-status: 'saved'`, falsely indicating that unwritten data is safely stored in the database.
   - **High Security Awareness Impersonation (`socketHandler.ts:296-320`):** The server blindly relays client-supplied awareness payloads without verifying that the embedded user identity matches the authenticated socket session (`socket.data.user`). Any collaborator can spoof user IDs, names, or administrative roles in cursor tags.
   - **High Ghost Cursor Retention (`socketHandler.ts:42, 352`):** When sockets disconnect or collaborators are revoked, awareness states are not explicitly evicted from `room.awareness`. Ghost cursors remain visible to other collaborators for up to 30 seconds.
   - **Medium Persistence Starvation (`roomManager.ts:235-248`):** The write-behind debounce resets trailing timers on every keystroke without a `maxWait` ceiling, allowing sustained typing to delay database persistence indefinitely.

**Audit Recommendation:** Do not proceed to Phase 3 until the prioritized remediation plan in Section 10 is reviewed, approved, and implemented.

---

## 2. Actual Runtime, Git Status & Test Results

### 2.1 Git Working Tree & Branch
- **Branch:** `main` (up to date with `origin/main`)
- **Status:** Clean of accidental commits; `README.md` tracked changes preserved; untracked project files present.
- **Commit History:** Preserved cleanly without force pushes or unauthorized branch modifications.

### 2.2 Configured Runtime Verification
```bash
$ node -v
v22.14.0

$ npm -v
10.9.2

$ docker ps
CONTAINER ID   IMAGE       STATUS          PORTS                      NAMES
1a609dfcf32d   mongo:7.0   Up 15 minutes   0.0.0.0:27017->27017/tcp   collabsync-mongodb
```

### 2.3 Automated Test Suite Execution (Vitest 3.2.7)
All 43 tests pass across 6 suites using `mongodb-memory-server`:
```
 ✓ tests/yjs-convergence.test.ts (4 tests) 20ms
 ✓ tests/e2e-smoke.test.ts (1 test) 3417ms
 ✓ tests/auth.test.ts (11 tests) 6716ms
 ✓ tests/documents.test.ts (10 tests) 8841ms
 ✓ tests/socket.test.ts (10 tests) 9272ms
 ✓ tests/persistence-awareness.test.ts (7 tests) 9440ms

 Test Files  6 passed (6)
      Tests  43 passed (43)
   Duration  12.85s
```

### 2.4 Production Compilation & Build Status
- `npm run build:server` (`tsc`): **0 TypeScript errors**.
- `npm run build:client` (`tsc && vite build`): **0 errors**, generated optimized production client bundle (`dist/index.html` 0.75 kB, `dist/assets/index-*.js` 663 kB).

---

## 3. Findings Categorized by Severity

| ID | Title | Severity | Location | Defect Type |
|---|---|---|---|---|
| **CRIT-01** | Idle eviction flush race destroys active `Y.Doc` on concurrent reconnect | **Critical** | `server/src/sockets/roomManager.ts:185-197` | Concurrency / Crash / Data Loss |
| **CRIT-02** | Silent `saved` false-positive on deleted or missing MongoDB documents | **Critical** | `server/src/sockets/roomManager.ts:277-293` | Data Integrity / False Save |
| **HIGH-01** | Unsanitized awareness updates allow user impersonation and identity spoofing | **High** | `server/src/sockets/socketHandler.ts:296-320` | Security / Identity Spoofing |
| **HIGH-02** | Awareness states not cleared on disconnect or collaborator revocation (ghost cursors) | **High** | `server/src/sockets/socketHandler.ts:42, 352` | Presence Leak / Ghost Cursors |
| **MED-01** | Missing `maxWait` debounce ceiling permits indefinite persistence starvation | **Medium** | `server/src/sockets/roomManager.ts:235-248` | Reliability / Delayed Write |
| **MED-02** | Lack of database-level OCC version checks creates multi-instance overwrite risk | **Medium** | `server/src/sockets/roomManager.ts:277-286` | Architecture / OCC Concurrency |
| **MED-03** | Local edits permanently lost on full browser reload while offline | **Medium** | `client/src/hooks/useCollabEditor.ts:52, 65` | Architectural Limitation |
| **LOW-01** | Redundant full-state `initial-state` emission alongside `sync-step-2` diff | **Low** | `server/src/sockets/socketHandler.ts:167-172` | Bandwidth / Protocol Inefficiency |
| **LOW-02** | Hardcoded fixed retry interval rather than exponential backoff on write failure | **Low** | `server/src/sockets/roomManager.ts:303` | Resilience Polish |
| **INFO-01** | Vitest suite executes against in-memory MongoDB rather than native daemon | **Info** | `server/tests/setup.ts:7-11` | Testing Scope Limitation |

---

## 4. In-Depth Technical Analysis & Reproduction Evidence

### CRIT-01: Idle Eviction Flush Race Destroys Active `Y.Doc` on Concurrent Reconnect
- **File Reference:** `server/src/sockets/roomManager.ts:185-197`
- **Root Cause:**
  When all sockets leave a room (`activeSockets.size === 0`), `removeSocket` sets an idle eviction timer. When the timer fires:
  ```ts
  const timer = setTimeout(async () => {
    const currentRoom = this.rooms.get(docId);
    if (currentRoom && currentRoom.activeSockets.size === 0) {
      if (currentRoom.dirty) {
        await this.flushPersistence(docId); // <--- ASYNC SUSPENSION POINT
      }
      currentRoom.awareness.destroy();
      currentRoom.ydoc.destroy();
      this.rooms.delete(docId);
      this.idleTimers.delete(docId);
    }
  }, this.idleTimeoutMs);
  ```
  `await this.flushPersistence(docId)` performs database network I/O. If a client reconnects or a collaborator joins while the database write is awaiting completion:
  1. `getOrCreateRoom(docId)` returns `currentRoom`.
  2. The client adds its socket ID to `currentRoom.activeSockets` and starts editing `currentRoom.ydoc`.
  3. `flushPersistence` finishes.
  4. Execution resumes after the `await` and **unconditionally** calls `currentRoom.ydoc.destroy()` and `this.rooms.delete(docId)`.
  5. The active user's document is destroyed in memory. Subsequent keystrokes fail with `TypeError: Y.Doc is destroyed`, and all in-flight edits are wiped out.
- **Classification:** Confirmed Critical Defect.

---

### CRIT-02: Silent `saved` False-Positive on Deleted or Missing Documents
- **File Reference:** `server/src/sockets/roomManager.ts:277-293`
- **Root Cause:**
  `flushPersistence` persists document state using:
  ```ts
  const now = new Date();
  await DocumentModel.updateOne(
    { _id: docId },
    {
      $set: {
        contentBinary: Buffer.from(snapshot),
        lastSavedAt: now,
      },
    },
    { writeConcern: { w: 'majority' } }
  );

  room.lastSavedAt = now;
  if (room.version === snapshotVersion) {
    room.dirty = false;
    room.lastSavedVersion = snapshotVersion;
    this.notifySaveStatus(docId, 'saved', now);
  }
  ```
  In MongoDB and Mongoose, `updateOne` does not throw an error if no document matches the query; it returns `{ acknowledged: true, matchedCount: 0, modifiedCount: 0 }`.
  Because `result.matchedCount` is not checked, if a document was deleted in MongoDB while active in memory, `flushPersistence` marks `room.dirty = false`, records `lastSavedAt`, and broadcasts `save-status: 'saved'`.
- **Reproduction Evidence:**
  Demonstrated live against MongoDB container in `scratch/mongo-recovery-audit.mjs:132-155`:
  ```
  ✓ Deleted document from MongoDB directly while room is active in RAM
  ✓ flush-document returned: { success: true }
  ⚠️ CONFIRMED DEFECT: Server reported flush success=true even though document was deleted from MongoDB!
  ```
- **Classification:** Confirmed Critical Defect.

---

### HIGH-01: Unsanitized Awareness Updates Allow User Impersonation & Identity Spoofing
- **File Reference:** `server/src/sockets/socketHandler.ts:296-320`
- **Root Cause:**
  The server socket handler relays awareness payloads directly:
  ```ts
  socket.on('awareness-update', (payload: { docId: string; update: any }) => {
    const { docId, update } = payload || {};
    if (!docId || !update || !socket.rooms.has(docId)) return;

    try {
      const binaryUpdate = Buffer.isBuffer(update) ? ... : ...;
      const room = roomManager.getOrCreateRoom(docId);
      applyAwarenessUpdate(room.awareness, binaryUpdate, socket.id);

      socket.to(docId).emit('awareness-update', {
        docId,
        update: Buffer.from(binaryUpdate),
      });
    } catch (err: any) { ... }
  });
  ```
  The server never validates that the user name, user ID, or role embedded in the awareness binary matches `socket.data.user`. Any authenticated client can craft an awareness update asserting they are the document owner or another user.
- **Audit Mandate Check:** The prompt explicitly requires: *"User identity in awareness is derived from trusted server-side authentication, not blindly accepted from client payloads."* This requirement is currently unmet.
- **Classification:** Confirmed High Security Defect.

---

### HIGH-02: Ghost Cursors Retained on Disconnect or Collaborator Revocation
- **File Reference:** `server/src/sockets/socketHandler.ts:42, 352` & `server/src/sockets/roomManager.ts:10, 106, 177`
- **Root Cause:**
  When a user disconnects or is revoked via `revokeUserFromRoom`:
  1. `socket.leave(docId)` and `roomManager.removeSocket(docId, socket.id)` are called.
  2. `activeIO.to(docId).emit('user-left', ...)` is broadcast.
  3. However, `room.awareness` states associated with the socket's Yjs `clientID` are **never removed** using `removeAwarenessStates(room.awareness, [clientID], 'disconnect')`.
  4. Notice that in `server/src/sockets/roomManager.ts`:
     - Line 10 declares `socketAwarenessClients: Map<string, Set<number>>;`.
     - Line 106 instantiates it.
     - **It is never populated or referenced anywhere else in the codebase.**
  5. As a result, the peer's cursor remains frozen in all other collaborators' TipTap views for 30,000ms until the default awareness timeout passively expires.
- **Classification:** Confirmed High Defect.

---

### MED-01: Missing `maxWait` Ceiling in Persistence Debounce Window
- **File Reference:** `server/src/sockets/roomManager.ts:235-248`
- **Root Cause:**
  ```ts
  public schedulePersistence(docId: string, delayMs?: number): void {
    const room = this.rooms.get(docId);
    if (!room) return;

    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
    }
    const delay = delayMs ?? this.saveDebounceMs;
    room.saveTimer = setTimeout(async () => {
      room.saveTimer = null;
      await this.flushPersistence(docId);
    }, delay);
  }
  ```
  Every incoming update clears and restarts the 1500ms timer. If multiple collaborators type continuously without a 1.5-second pause, persistence is postponed indefinitely. While the Phase 2 plan specified `1500ms / maxWait 5000ms`, no `firstDirtyAt` or `maxWaitTimer` was implemented.
- **Classification:** Confirmed Medium Defect.

---

### MED-02: Absence of Database-Level Optimistic Concurrency Control (OCC)
- **File Reference:** `server/src/models/Document.ts:14-47`, `server/src/sockets/roomManager.ts:277-286`
- **Root Cause:**
  Monotonic version tracking is maintained solely in Node.js server RAM (`room.version`).
  The MongoDB schema has no `version` field.
  Persistence performs an unconditional `$set: { contentBinary: Buffer.from(snapshot), lastSavedAt: now }`.
  In a single-process deployment, `await room.savePromise` prevents write overlap. However, in a multi-instance, clustered, or failover deployment, MongoDB cannot detect if a write from an older snapshot completes after a newer write.
- **Classification:** Confirmed Architectural Risk / Limitation.

---

### MED-03: Permanent Edit Loss on Browser Reload While Offline
- **File Reference:** `client/src/hooks/useCollabEditor.ts:52, 65`
- **Root Cause:**
  TipTap and Yjs state are held in React state (`const currentYdoc = new Y.Doc()`).
  If a user goes offline and continues typing, edits accumulate in memory. If the user hits browser reload or navigates away before re-establishing connectivity, the Y.Doc instance is destroyed.
- **Classification:** Confirmed Scope Limitation. Must be documented as an explicit boundary of Phase 2.

---

### LOW-01: Redundant Full-Document Broadcast Alongside Differential Sync
- **File Reference:** `server/src/sockets/socketHandler.ts:160-172`
- **Root Cause:**
  Upon `join-document` with `stateVector`, the server computes and sends `sync-step-2` with the differential diff. Immediately following this, it also emits `initial-state` with the entire compiled document binary.
  Because Yjs is idempotent, no text is duplicated, but sending the full state nullifies the wire-efficiency benefit of differential synchronization.
- **Classification:** Confirmed Low Defect / Inefficiency.

---

### LOW-02: Fixed Retry Delay Rather Than Exponential Backoff
- **File Reference:** `server/src/sockets/roomManager.ts:303`
- **Root Cause:**
  Persistence failure hardcodes `this.schedulePersistence(docId, 2500)`. It does not increase backoff intervals or introduce jitter.
- **Classification:** Confirmed Low Polish Gap.

---

## 5. Trace of 11 Persistence & Data-Loss Scenarios

| # | Scenario | Evaluated Behavior | Risk / Finding |
|---|---|---|---|
| **1** | Rapid updates during debounce window | Updates increment `room.version` and mark `dirty = true`. Timer resets on each edit. | **MED-01:** Lack of `maxWait` can delay persistence indefinitely during continuous typing. |
| **2** | Update arrives while database write in progress | Database write captures `snapshotVersion = room.version`. When write finishes, `room.version > snapshotVersion`, so room stays `dirty = true` and schedules follow-up flush in 300ms. | **Verified Safe:** Handled correctly in RAM; does not emit premature `saved`. |
| **3** | Overlapping or out-of-order writes | `flushPersistence` awaits `room.savePromise`. Re-checks `room.dirty`. | **Verified Safe in Single Process.** In multi-process, lacks DB OCC (**MED-02**). |
| **4** | Temporary MongoDB write failure | Catches error, broadcasts `save-status: 'error'`, retains `dirty = true`, schedules retry in 2500ms. | **Verified Safe.** Edits remain in RAM awaiting retry. |
| **5** | Failed write retry triggered | Automatic retry in 2500ms or manual retry via `flush-document`. Emits `saved` only upon DB success. | **Verified Safe.** Never reports `saved` on failure. |
| **6** | Room becomes idle while persistence pending | Socket leaves; idle timer (10 min) starts. Default debounce (1.5s) completes hours before idle eviction. | **Verified Safe under standard timeouts.** |
| **7** | Room evicted while write in progress | Timer fires; awaits `flushPersistence`. If client joins during await, Y.Doc is destroyed! | **CRIT-01 Confirmed Defect:** Causes session crash and data loss. |
| **8** | Process receives SIGTERM/SIGINT | `server.ts` traps signals, awaits `roomManager.flushAll()` before closing sockets and DB. | **Verified Safe:** Graceful shutdown commits dirty rooms. |
| **9** | Unexpected termination (`SIGKILL`, power loss) | In-memory edits within 1500ms debounce window or in-flight packets are lost. | **Architectural Guarantee Boundary:** Edits unacknowledged by DB do not survive abrupt crashes. |
| **10** | Concurrent room initialization | First join initiates `room.initPromise`. Subsequent joins await existing promise. | **Verified Safe:** Deduplication prevents duplicate DB reads. |
| **11** | Room re-created while earlier persistence runs | Room being destroyed is returned by `getOrCreateRoom` during await, then deleted from under caller. | **CRIT-01 Consequence:** Session corruption. |

---

## 6. Real MongoDB Verification vs. In-Memory Tests

### 6.1 Database Verification Matrix

| Check | Vitest Automated Test Suite | Live Container Verification (`mongo:7.0`) |
|---|---|---|
| **Database Instance** | `mongodb-memory-server` (ephemeral) | Native Docker Container `collabsync-mongodb` on port `27017` |
| **Persistence Storage** | Verified BSON Buffer in memory | Verified raw BSON BinData in physical container storage |
| **Server Crash / Restart** | Simulated via `roomManager.clearAllRooms()` | Verified via **genuine OS process termination & cold reboot** |
| **Post-Restart Reconstitution** | Verified | Verified: `"Pre-restart durable text."` restored and appended to |
| **Empty Content Handling** | Verified | Verified: `contentBinary` correctly initialized to `null` |
| **Corrupt / Malformed Binary** | Not in test suite | Verified: Server logs warning, initializes empty Y.Doc without crashing |
| **Deleted Document Write** | Not in test suite | **CRIT-02 Discovered:** Returns `matchedCount: 0`, falsely emits `saved` |

---

## 7. Reconnection, 2-Step Sync & Concurrency Audit

1. **State-Vector Diffing:**
   - Client sends `stateVector: Array.from(Y.encodeStateVector(currentYdoc))` on `join-document`.
   - Server computes `diff = Y.encodeStateAsUpdate(room.ydoc, clientVector)` and emits `sync-step-2`.
   - Verified: Only missing deltas are applied to local Y.Doc.
2. **Offline Edit Convergence:**
   - Server emits `sync-step-1` with its state vector.
   - Client computes missing offline edits and emits `sync-step-2` back to server.
   - Server applies via `roomManager.applyUpdate` and broadcasts to peers.
   - Verified: Offline edits merge seamlessly using Yjs CRDT mathematics.
3. **Idempotency:**
   - Redundant or repeated synchronization updates produce identical Y.Doc states without duplicating text.
4. **Browser Reload Limitation:**
   - Fully reloaded browser tabs lose offline unsaved edits (**MED-03**).

---

## 8. Security & Authorization Audit

1. **HTTP & Handshake Authentication:**
   - Handshake verifies JWT token from `auth.token` or HTTP-only cookie `collabsync_token`.
   - Rejects unauthenticated connections with `UNAUTHORIZED`.
2. **Document Room Authorization:**
   - `join-document` strictly validates ownership or collaborator inclusion against MongoDB.
   - Non-collaborators are rejected with `403 FORBIDDEN`.
3. **Immediate Revocation:**
   - When owner revokes collaborator via REST `DELETE /api/documents/:id/collaborators/:userId`, server executes `revokeUserFromRoom`.
   - Actively connected sockets for that user are ejected from the Socket.IO room, evicted from `roomManager`, and receive `document-error: ACCESS_REVOKED`.
   - Reconnect attempts are rejected with `403 FORBIDDEN`.
4. **Vulnerabilities Identified:**
   - **HIGH-01:** Awareness user identity is spoofable.
   - **HIGH-02:** Ephemeral awareness states are not cleared upon socket disconnect or collaborator revocation.

---

## 9. Test Suite Audit & Gap Analysis

### 9.1 Existing Tests and What They Prove

| Test File | Test Name | Claimed Guarantee | Verification Verdict |
|---|---|---|---|
| `persistence-awareness.test.ts` | Test 1 | Debounced binary persistence to MongoDB | **Proven:** Validates BSON buffer and decodable Yjs content. |
| `persistence-awareness.test.ts` | Test 2 | Crash & restart reconstitution | **Partially Proven:** Proves in-memory room reset; genuine process restart was proven only by our live audit script. |
| `persistence-awareness.test.ts` | Test 3 | Reconnection 2-step differential sync | **Proven:** Validates delta exchange and offline edit convergence. |
| `persistence-awareness.test.ts` | Test 4 | Update idempotency | **Proven:** Validates identical updates do not duplicate content. |
| `persistence-awareness.test.ts` | Test 5 | Eviction flush before RAM destruction | **Partially Proven:** Proves clean flush, but does NOT exercise the concurrent join race condition (**CRIT-01**). |
| `persistence-awareness.test.ts` | Test 6 | Ephemeral awareness without DB write | **Proven:** Confirms awareness is broadcast and excluded from `contentBinary`. |
| `persistence-awareness.test.ts` | Test 7 | Revocation prevents reconnect | **Proven:** Confirms revoked user cannot rejoin. |

### 9.2 Missing Test Coverage

1. **Eviction Flush Race:** No test joins or edits a room while `flushPersistence` is awaiting database resolution.
2. **Deleted Document Save:** No test verifies `matchedCount === 1` during persistence.
3. **Delayed / Out-of-Order DB Writes:** No test injects database latency to test write queueing under load.
4. **Database Failure & Retry:** No test mocks MongoDB failure to assert `save-status: 'error'` transitions and backoff retries.
5. **Awareness Spoofing & Cleanup:** No test verifies awareness identity validation or immediate cursor eviction on disconnect.
6. **Debounce MaxWait:** No test verifies that continuous keystrokes flush within a maximum time ceiling.

---

## 10. Prioritized Remediation Plan

The following repair plan must be reviewed and approved before modifying application source code:

### Priority 1: Critical Reliability & Concurrency Fixes
1. **Fix Eviction Flush Race Condition (`server/src/sockets/roomManager.ts`):**
   - In `removeSocket`: When the eviction timeout fires, re-verify `currentRoom.activeSockets.size === 0` **after** `await this.flushPersistence(docId)`.
   - If a new socket joined or edits arrived during the flush, abort eviction and leave the room alive.
   - Track an `isEvicting` state flag to prevent re-entrant destruction.
2. **Fix Silent Save False-Positive on Deleted Documents (`server/src/sockets/roomManager.ts`):**
   - In `flushPersistence`: Inspect `result.matchedCount` from `DocumentModel.updateOne`.
   - If `matchedCount === 0`, throw an explicit error (`Document does not exist or was deleted from database`).
   - Emit `save-status: 'error'` and leave `room.dirty = true` (or cleanly dismantle the room).

### Priority 2: Security & Presence Hardening
3. **Sanitize Awareness Identity from Server Session (`server/src/sockets/socketHandler.ts`):**
   - Maintain client-to-socket awareness mappings in `roomManager.socketAwarenessClients`.
   - Enforce that awareness updates only modify states belonging to the authenticated user (`socket.data.user.id`, `socket.data.user.name`).
   - Strip client-supplied user metadata and inject server-verified user info.
4. **Immediate Awareness Cleanup on Disconnect / Revocation (`server/src/sockets/socketHandler.ts`):**
   - When a socket leaves, disconnects, or is revoked, retrieve its associated awareness client IDs and call `removeAwarenessStates(room.awareness, clientIDs, 'socket-disconnect')`.
   - Broadcast the removal update immediately to prevent ghost cursors.

### Priority 3: Persistence Reliability & Protocol Efficiency
5. **Implement `maxWait` Ceiling for Write-Behind Debounce (`server/src/sockets/roomManager.ts`):**
   - Track `room.firstDirtyAt`.
   - If continuous edits occur, force a flush once elapsed time exceeds `maxWaitMs` (default: 5000ms), preventing persistence starvation.
6. **Eliminate Redundant Full-State Broadcast on Differential Reconnect (`server/src/sockets/socketHandler.ts`):**
   - When a client supplies a valid `stateVector` in `join-document`, omit the full `initial-state` emission and deliver only `sync-step-2`.
   - Keep `initial-state` only for initial joins where no state vector is provided.
7. **Add Automated Regression Tests for All Findings:**
   - Add test for eviction flush during concurrent reconnect.
   - Add test for deleted document persistence failure.
   - Add test for awareness identity enforcement and cursor disconnect cleanup.

---

## 11. Final Sign-Off & Next Steps

This concludes the independent Phase 2 audit. All findings have been cataloged with file lines, root causes, reproduction steps, and observable runtime evidence.

**Action Required:** Awaiting user review and approval of the findings and remediation plan. Application source code has NOT been modified during this audit.

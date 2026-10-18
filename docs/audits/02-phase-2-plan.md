# CollabSync — Phase 2 Architecture & Implementation Plan

> **Phase:** Phase 2 — Durable Persistence, Reconnection & Live Awareness  
> **Date:** 2026-10-17  
> **Baseline:** Approved Phase 1 codebase (36/36 tests passing, Node 22 LTS, standardized RBAC and Socket.IO rooms)

---

## 1. System Audit & Baseline Review

Phase 1 established:
- **Authentication & RBAC:** User accounts in MongoDB, bcrypt hashing, dual-mode JWT (HTTP-only cookies + Bearer token), strict owner and collaborator authorization in REST and Socket.IO.
- **In-Memory CRDTs:** `RoomManager` holds `Map<string, RoomState>` with `ydoc: Y.Doc`. Document updates are relayed in real time between peers.
- **Lifecycle & Eviction:** 10-minute idle room eviction when socket count reaches 0; immediate socket room eviction with `ACCESS_REVOKED` when collaborator permissions are deleted.

### Gaps to be Addressed in Phase 2
1. **Content Persistence:** Editor text is stored only in RAM. Server restart causes total content loss.
2. **Reconnection & Catch-Up:** Reconnection relies on monolithic full-state delivery; no differential Yjs state-vector exchange for offline/intermittent drops.
3. **Collaborator Awareness:** Presence is currently basic socket-level join/leave events; no live cursor carats, selection ranges, or ephemeral client state.
4. **Save-Status Transparency:** The UI displays a static Phase 1 in-memory disclaimer; no real-time feedback on database persistence status.

---

## 2. Technical Design & Architecture

### 2.1 Database Schema Migration (`server/src/models/Document.ts`)
Extend the existing Mongoose `DocumentSchema` with binary content storage:

```ts
export interface IDocument extends MongooseDoc {
  _id: mongoose.Types.ObjectId;
  title: string;
  owner: mongoose.Types.ObjectId;
  collaborators: mongoose.Types.ObjectId[];
  contentBinary: Buffer | null;  // Yjs compiled document state (BSON BinData)
  lastSavedAt: Date | null;       // Timestamp of last successful database commit
  createdAt: Date;
  updatedAt: Date;
}
```

- **Storage Format:** Compacted binary Yjs update (`Y.encodeStateAsUpdate(ydoc)`), converted to `Buffer`.
- **Why binary?** Storing CRDT update binaries preserves complete Yjs history and data structures (formatting, marks, nodes) without error-prone JSON or HTML parsing/serialization.

---

### 2.2 Room Lifecycle & Controlled Persistence Strategy (`RoomManager`)

```
   Client Updates
         │
         ▼
┌──────────────────┐
│  RoomManager     │ ──> Increments room.version
│  (In-Memory CRDT)│ ──> Emits save-status: 'saving'
└────────┬─────────┘ ──> Debounce Timer (1500ms / maxWait 5000ms)
         │
         ▼
┌──────────────────┐
│  Flush to Mongo  │ ──> Compares snapshotVersion with room.version
│  (Write-Behind)  │ ──> { writeConcern: { w: 'majority' } }
└────────┬─────────┘
         │
         ├─ Success ──> room.dirty = false; emit save-status: 'saved'
         └─ Failure ──> emit save-status: 'error'; exponential backoff retry
```

1. **Lazy Asynchronous Room Initialization:**
   - When a room is requested (`roomManager.getOrCreateRoom(docId)`), if not in memory, query MongoDB.
   - If `contentBinary` exists, apply it to the new `Y.Doc` (`Y.applyUpdate(room.ydoc, contentBinary, 'init')`).
   - Deduplicate concurrent room initialization promises to prevent race conditions during simultaneous user joins.
2. **Monotonic Version Tracking (Prevent Stale Overwrites):**
   - Each mutation increments `room.version`.
   - Persistence takes a snapshot: `snapshot = Y.encodeStateAsUpdate(room.ydoc); snapshotVersion = room.version;`.
   - When MongoDB write succeeds: if `room.version === snapshotVersion`, mark clean (`room.dirty = false`); if newer edits arrived in the interim, schedule another save.
3. **Eviction & Shutdown Flush Guarantees:**
   - Before an idle room is evicted from RAM (`roomManager.destroyRoom(docId)`), pending writes are awaited: `await roomManager.flushPersistence(docId)`.
   - On server shutdown (`SIGTERM`/`SIGINT`), all dirty rooms are flushed before database disconnection.

---

### 2.3 Reconnection & Yjs Differential Synchronization Protocol

Implement standard 2-step Yjs state-vector synchronization:

```
Reconnecting Client                                Server (RoomManager)
        │                                                    │
        │ ─── 1. join-document { docId, stateVector } ──────>│
        │                                                    │ (Computes diff:
        │                                                    │  serverDoc relative to
        │                                                    │  clientStateVector)
        │<─── 2. sync-step-2 { docId, update: diff } ────────│
        │                                                    │
        │<─── 3. sync-step-1 { docId, stateVector: sVector }─│
        │                                                    │
(Computes local diff relative                                │
 to sVector)                                                 │
        │ ─── 4. sync-step-2 { docId, update: clientDiff } ─>│
        │                                                    │ (Applies clientDiff,
        │                                                    │  relays to peers)
```

- **State Vector Diffing:** Only missing deltas are transmitted over the wire.
- **Offline Edit Merging:** If a client made local edits while disconnected, they are cleanly integrated upon reconnection via CRDT math without replacing newer edits.
- **RBAC Re-verification:** Reconnection verifies JWT and re-queries MongoDB document permissions; revoked collaborators are rejected on reconnect.

---

### 2.4 Live Collaborator Awareness & Cursors

- **Protocol:** `y-protocols/awareness` manages ephemeral presence and cursor coordinates.
- **No Persistence:** Awareness states are strictly in-memory and are never written to MongoDB.
- **Server Relay:** Server manages room awareness, receives `awareness-update`, applies updates to room awareness, and broadcasts to peers.
- **Cleanup:** On client disconnect, leave, or revocation, the server marks the client ID as deleted in awareness and notifies peers.
- **Client Integration:** Configure `@tiptap/extension-collaboration-cursor` with user name, color, and awareness instance.

---

### 2.5 Honest Save-Status Feedback

- Server broadcasts `save-status` event to room members:
  - `{ docId, status: 'saving' | 'saved' | 'error', lastSavedAt?: string, message?: string }`
- Client UI displays an authentic status indicator:
  - **Saved** (emerald badge with checkmark)
  - **Saving...** (indigo badge with spin animation)
  - **Save Error** (rose badge with retry option)

---

## 3. Step-by-Step Execution Plan

1. **Step 2.1: Model & RoomManager Persistence**
   - Add `contentBinary` and `lastSavedAt` to `server/src/models/Document.ts`.
   - Implement asynchronous initialization, debounced write-behind, version tracking, and `flushPersistence` in `server/src/sockets/roomManager.ts`.
   - Add tests for initial persistence, reload, and race conditions.
2. **Step 2.2: Server Restart Recovery & Graceful Shutdown**
   - Wire persistence into `socketHandler.ts` and `server.ts` shutdown hook.
   - Add test simulating server restart and document recovery.
3. **Step 2.3: Yjs 2-Step Sync & Reconnection**
   - Implement `sync-step-1` and `sync-step-2` handlers in `socketHandler.ts` and `useCollabEditor.ts`.
   - Add tests for disconnect, reconnect, offline edits, and duplicate message deduplication.
4. **Step 2.4: Live Awareness & Live Cursors**
   - Add awareness event handlers on server.
   - Configure awareness and cursor extension in client editor.
   - Add tests for awareness broadcast and disconnect cleanup.
5. **Step 2.5: Honest Save Status & Failure Handling UI**
   - Broadcast save status from `RoomManager` through Socket.IO.
   - Update `useCollabEditor.ts` and `EditorPage.tsx` to display save status with retry handling.
6. **Step 2.6: Comprehensive Test Verification & Final Audit**
   - Run full workspace typecheck, builds, and test suite.
   - Produce final Phase 2 audit report.

# CollabSync — Architecture Specification & Phase 0 Audit Report

## 1. Repository and Environment Findings

### 1.1 Workspace State
- **Workspace Path:** `/Users/balajiaadesh/Desktop/projects/CollabSync`
- **Git Status:** 
  - Repository initialized and clean (`working tree clean`).
  - Active Branch: `main` (tracked with `origin/main`).
  - Remote URL: `https://github.com/balaji-aadi/CollabSync.git`.
  - Commit History: Single commit `09bc1db Initial commit`.
- **Existing Files:**
  - `.git/` (Git repository metadata)
  - `README.md` (12 bytes: `# CollabSync\n`)
- **Repository Classification:** Clean slate repository. No existing code, scaffolding, or configurations will be overwritten or lost.

### 1.2 Toolchain & Runtime Environment
- **Node.js:** `v23.1.0` (Apple Silicon Darwin arm64)
- **npm:** `10.9.0`
- **Package Manager / Lockfiles:** None present at Phase 0 inception.
- **Docker Toolchain:**
  - Docker CLI: `v28.3.2` (build `578ccf6`) installed.
  - Docker Desktop: Application exists at `/Applications/Docker.app`.
  - Docker Daemon Status: Inactive / stopped during Phase 0 audit.
- **Database Availability:**
  - Native `mongod` / `mongosh`: Not present in system `$PATH`.
  - Homebrew: `mongodb-database-tools` is installed; local daemon is not running.
  - Database Strategy: A lightweight `docker-compose.yml` defining a `mongo:7.0` service (with local volume persistence) provides the cleanest, zero-pollution reproducible local development environment, or alternatively a MongoDB Atlas connection string configured via `.env`. In-memory MongoDB (`mongodb-memory-server`) is selected for self-contained automated testing.

---

## 2. Defined MVP Scope & Core Capabilities

The objective is a focused, technically credible collaborative document editing platform demonstrating real-time CRDT synchronization, reliable state recovery, and cursor presence.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              COLLABSYNC MVP                                 │
├───────────────────┬──────────────────────┬──────────────────────────────────┤
│ Auth & Documents  │ Concurrent CRDT Sync │ Reconnection, Recovery & Presence│
├───────────────────┼──────────────────────┼──────────────────────────────────┤
│ • JWT Auth        │ • TipTap + Yjs Doc   │ • Socket.IO Transport Recovery   │
│ • Document CRUD   │ • Socket.IO Rooms    │ • Yjs State Vector Resync (1 & 2)│
│ • Owner/Collab RBAC│ • Delta Updates     │ • Debounced MongoDB Persistence  │
│ • Monotonic Ver.  │ • Commutative Merge  │ • Ephemeral Cursor Awareness     │
└───────────────────┴──────────────────────┴──────────────────────────────────┘
```

### A. Authentication & Documents
- **User Authentication:** Email/password registration and login with JWTs (HTTP-only secure cookie or standard `Authorization: Bearer <token>` header), hashed passwords using `bcrypt`.
- **Document Management:** REST endpoints to create, list, rename, and retrieve metadata for documents.
- **Access Control:** Explicit authorization check. Documents maintain an `ownerId` and an optional `collaboratorIds` array. Only authorized users can fetch document metadata or join a real-time editing room.

### B. Collaborative Editing
- **Client-Side Editor:** React with TipTap (a headless, extensible ProseMirror wrapper) paired with `@tiptap/extension-collaboration` and `@tiptap/extension-collaboration-cursor`. TipTap provides clean, production-grade text editing bound natively to Yjs without needing custom CRDT wrappers.
- **CRDT Synchronization:** Shared document state represented as a `Y.Doc`. TipTap operations map deterministically to `Y.XmlFragment` / `Y.Text` mutations.
- **Room Management:** Socket.IO rooms partitioned by `docId`. The server manages an active in-memory `Y.Doc` instance for each open room.
- **Convergence:** Edits from multiple concurrent users converge deterministically without central lock negotiation or operational transformation matrices.

### C. Reconnection & Recovery
- **Transport Reconnection:** Socket.IO handles physical connection retry, exponential backoff, and socket ID re-registration.
- **Document State Catch-up:** On reconnect, the client does not overwrite or blindly pull the document. It executes the standard **Yjs 2-Step Sync Protocol**:
  1. Client sends its `stateVector` (`Y.encodeStateVector(clientDoc)`).
  2. Server calculates the delta diff (`Y.encodeStateAsUpdate(serverDoc, clientVector)`) and sends it back.
  3. Client applies the delta (`Y.applyUpdate(clientDoc, diff)`).
  4. Symmetrically, client pushes any offline edits made during disconnection.
- **Server Restart Recovery:** When a document room is initialized on the server, the server loads the persisted binary update/snapshot from MongoDB before allowing clients to sync.

### D. Presence & Awareness
- **User Presence:** Connected collaborators are shown with visual avatar chips and distinct user colors.
- **Cursor Awareness:** Live selection ranges and caret positions are synchronized via `y-protocols/awareness`.
- **Ephemeral Separation:** Awareness messages (`awareness-update`) are broadcast strictly in-memory over Socket.IO and are **never** persisted to MongoDB.

---

## 3. Technology Stack & Integration Architecture

| Layer | Technology | Justification & Role |
| :--- | :--- | :--- |
| **Frontend Framework** | React 18 + Vite | Fast HMR, clean component tree, simple build toolchain. |
| **Styling** | Tailwind CSS | Sleek, modern, responsive typography and dark/light UI tokens. |
| **Editor** | TipTap (`@tiptap/react`, `@tiptap/starter-kit`) | ProseMirror-backed, battle-tested for Yjs collaboration. |
| **CRDT Engine** | `yjs`, `y-protocols` | Industry-standard CRDT for shared text; handles mathematical convergence. |
| **Real-time Client** | `socket.io-client` | Bi-directional event transport, room messaging, automatic reconnects. |
| **Backend Runtime** | Node.js LTS (Express) | REST API endpoints for authentication and document metadata CRUD. |
| **Real-time Server** | `socket.io` | Manages authenticated WebSocket/polling connections and room routing. |
| **Database** | MongoDB + Mongoose | Stores users, document metadata, and binary Yjs document snapshots. |
| **Automated Testing** | Vitest, Supertest | Fast unit and integration tests for REST routes, sockets, and CRDT sync. |
| **Dev Environment** | Docker Compose (Optional) | Single-command MongoDB container for local reproducibility. |

### Architectural Boundaries & Separation of Concerns

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RESPONSIBILITY BOUNDARIES                         │
├─────────────────────┬───────────────────────────────────────────────────────┤
│ Socket.IO           │ Transport only: connection lifecycle, reconnects,    │
│                     │ packet serialization, and room partitioning.          │
├─────────────────────┼───────────────────────────────────────────────────────┤
│ Yjs CRDT            │ Shared state only: conflict resolution, delta diffs,  │
│                     │ causality tracking (Lamport clocks), and convergence. │
├─────────────────────┼───────────────────────────────────────────────────────┤
│ Application Server  │ Policy only: JWT authentication, room access control, │
│                     │ room lifecycle, and coordinating DB persistence.      │
├─────────────────────┼───────────────────────────────────────────────────────┤
│ MongoDB             │ Durability only: durable records for users, document  │
│                     │ metadata, and compiled Yjs binary state blobs.        │
└─────────────────────┴───────────────────────────────────────────────────────┘
```

---

## 4. Critical Architecture Questions & Technical Decisions

### 1. How authenticated users are authorized to join document rooms
- **Handshake Authentication:** During the Socket.IO connection handshake, the client passes the JWT in the `auth` payload (`io({ auth: { token } })`) or via HTTP cookies. A Socket.IO connection middleware verifies the JWT. If invalid or expired, the socket connection is rejected immediately.
- **Room Join Authorization:** When a client emits `join-document { docId }`, the server queries MongoDB for the document. It validates that `socket.user.id` matches `document.ownerId` or is present in `document.collaboratorIds`. Only if authorized does the server execute `socket.join(docId)`.

### 2. How Yjs updates are synchronized between clients
- When the user edits in TipTap, TipTap dispatches changes to the local `Y.Doc`.
- The `Y.Doc` fires an `update` event: `ydoc.on('update', (update, origin) => { ... })`.
- If `origin !== 'server'` and `origin !== 'socket'`, the client emits `document-update { docId, update: Uint8Array }` to the backend.
- The server receives the update, applies it to its in-memory `Y.Doc` (`Y.applyUpdate(serverDoc, update, socket.id)`), and broadcasts the update to all peers in the room: `socket.to(docId).emit('document-update', { docId, update })`.
- Other clients receive the event and call `Y.applyUpdate(clientDoc, update, 'socket')`. The origin check strictly prevents echo loops.

### 3. How document changes are persisted durably (Scheduled for Phase 2)
- The server maintains an active `Y.Doc` instance for any open document room.
- Updates are batched using a **debounced write-behind strategy** (e.g., 2,000ms idle debounce with a 5,000ms max-wait ceiling).
- Upon timer trigger, the server serializes the full compiled document state using `Y.encodeStateAsUpdate(serverDoc)`.
- The resulting `Buffer` is written to MongoDB with write concern `w: 'majority'`.
- When the last client leaves a room, a final flush is executed immediately before freeing the in-memory `Y.Doc`.

### 4. How the server restores document state after a restart (Scheduled for Phase 2)
- When the first client connects to a room after a server restart, the server checks its in-memory map.
- Seeing no active instance, it fetches the document record from MongoDB.
- If `contentBinary` exists, the server instantiates `const ydoc = new Y.Doc()` and loads the state via `Y.applyUpdate(ydoc, document.contentBinary)`.
- Once initialized, the server joins the client to the room and begins the 2-step sync protocol.

### 5. How duplicate updates and out-of-order message delivery are handled
- Yjs updates are **idempotent**, **commutative**, and **associative**.
- Each update contains internal logical timestamps (Lamport clocks) and unique Client IDs.
- If an update arrives twice, applying it a second time is a complete no-op.
- If updates arrive out of order, Yjs internally buffers any update whose causal parent is missing until the prerequisite update is received, then applies them cleanly.

### 6. How reconnecting clients obtain the latest state without replacing it with stale data (Scheduled for Phase 2)
- Socket.IO reconnection triggers an automatic re-join event `join-document`.
- The client and server run the **Yjs 2-Step Sync Protocol**:
  - Client sends `sync-step-1 { docId, stateVector: Y.encodeStateVector(clientDoc) }`.
  - Server computes the missing delta: `const missing = Y.encodeStateAsUpdate(serverDoc, clientStateVector)`.
  - Server sends back `sync-step-2 { docId, update: missing }`.
  - Client calls `Y.applyUpdate(clientDoc, missing)`.
  - Symmetrically, client pushes any offline edits made during disconnection.

### 7. How document versions, snapshots, or update logs should be stored (Scheduled for Phase 2)
- MongoDB stores document metadata alongside `contentBinary` (compiled Yjs binary blob) and an integer `version` incremented on each snapshot write.

### 8. How persistence failures are surfaced and retried safely (Scheduled for Phase 2)
- Exponential backoff retry with dirty-state preservation in memory. If persistent write fails, users are alerted with save state warnings.

### 9. How presence information is broadcast without polluting persistent document data
- Awareness state (`y-protocols/awareness`) is ephemeral and broadcast directly over Socket.IO in-memory channels. It is never stored in MongoDB.

### 10. How concurrent edits, disconnects, reconnection, server restart, and unauthorized access will be tested
- Handled via an automated test matrix using Vitest with multi-client socket simulators and mock database sessions.

---

## 5. Persistence Design & Trade-Off Analysis

Option A (Full Yjs Snapshot with Debounced Write-Behind & Graceful Flush) was selected over Option B (Incremental Update Log) due to bounded O(1) storage per document, instant recovery time, lower schema complexity, and mathematical convergence guarantees built into Yjs snapshots. Persistence of editor content is deferred to Phase 2.

---

## 6. Comprehensive Test Strategy
- Vitest + Supertest for REST API testing.
- Vitest + `socket.io-client` for real-time socket transport and room authorization.
- Headless `Y.Doc` tests for CRDT convergence and idempotency.
- In-memory MongoDB (`mongodb-memory-server`) to ensure zero-dependency, isolated test runs.

---

## 7. Explicit Scope & Boundary Control
Features explicitly excluded:
- Rich-text bloat (no tables, video embeds, math formulas).
- Canvas/Whiteboard.
- Comments/Suggestions.
- Voice/Video calls.
- Custom CRDT/OT algorithms.
- Redis/Multi-server clustering.
- Cloud/Kubernetes orchestration.

---

## 8. Proposed Phase Roadmap
- **Phase 0:** Audit & Architecture Proposal (Completed).
- **Phase 1:** Foundation, Authentication, Document CRUD & Core Live Sync (Current target).
- **Phase 2:** Durable Persistence, Resilient Reconnection & Cursor Presence.
- **Phase 3:** Comprehensive Test Suite, Docker Setup, Documentation & Polish.

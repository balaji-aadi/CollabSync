# CollabSync — Real-Time Collaborative Document Editor

> **Phase 2 Complete:** Durable Persistence, Reconnection Recovery & Live Awareness.  
> **Status:** 58 automated tests passing, zero TypeScript errors.

CollabSync is a focused, interview-defensible collaborative document editor designed to demonstrate real-time CRDT synchronization, reliable room management, document access control, durable MongoDB persistence, and live cursor presence using modern web standards.

---

## 1. Architecture & Design

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             SYSTEM ARCHITECTURE                             │
│                                                                             │
│   ┌───────────────────────────┐         ┌───────────────────────────┐       │
│   │   Browser Session A       │         │   Browser Session B       │       │
│   │   React 18 + TipTap       │         │   React 18 + TipTap       │       │
│   │   Y.Doc + Awareness       │         │   Y.Doc + Awareness       │       │
│   └─────────────┬─────────────┘         └─────────────┬─────────────┘       │
│                 │ Binary CRDT &                       │ Binary CRDT &       │
│                 │ Awareness Updates                   │ Awareness Updates   │
│                 ▼                                     ▼                     │
│   ┌─────────────────────────────────────────────────────────────────┐       │
│   │                       Node.js + Express                         │       │
│   │                Socket.IO Transport & Room Router                │       │
│   │                                                                 │       │
│   │    ┌───────────────────────────────────────────────────────┐    │       │
│   │    │            RoomManager (Active Sessions)              │    │       │
│   │    │  • In-Memory Y.Doc & Ephemeral Room Awareness         │    │       │
│   │    │  • Monotonic Version Tracking & Debounced Persistence │    │       │
│   │    │  • Eviction Flush & Graceful Shutdown Safety          │    │       │
│   │    └───────────────────────────┬───────────────────────────┘    │       │
│   │                                │                                │       │
│   │    ┌──────────────────┐        │      ┌───────────────────┐     │       │
│   │    │ Auth Middleware  │        │      │ Document RBAC     │     │       │
│   │    │ JWT Verification │        │      │ Owner / Collabs   │     │       │
│   │    └─────────┬────────┘        │      └─────────┬─────────┘     │       │
│   └──────────────┼─────────────────┼────────────────┼───────────────┘       │
│                  │                 │ Debounced      │                       │
│                  │                 │ Write-Behind   │                       │
│                  ▼                 ▼                ▼                       │
│   ┌─────────────────────────────────────────────────────────────────┐       │
│   │                         MongoDB 7.0                             │       │
│   │   • Users (email, name, passwordHash)                           │       │
│   │   • Documents Metadata (title, ownerId, collaboratorIds)        │       │
│   │   • contentBinary: Buffer (Durable Yjs CRDT update binary)      │       │
│   │   • lastSavedAt: Date (Timestamp of last successful commit)     │       │
│   └─────────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘
```

For complete technical specifications and sequence diagrams, refer to [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [02-phase-2-plan.md](docs/audits/02-phase-2-plan.md).

---

## 2. Technology Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS.
- **Editor:** TipTap (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-cursor`).
- **CRDT Engine:** Yjs (`yjs`) & `y-protocols` (`y-protocols/awareness`, `y-protocols/sync`) — provides deterministic conflict resolution and live presence.
- **Real-Time Transport:** Socket.IO client and server.
- **Backend:** Node.js 22 LTS (Active LTS pinned in `.nvmrc` as `22.14.0`), Express, TypeScript.
- **Database:** MongoDB 7.0 with Mongoose (stores document metadata and durable `contentBinary` BSON).
- **Security:** HTTP-only cookies, JWT auth, `bcryptjs` password hashing, Zod validation, rate limiting.
- **Automated Testing:** Vitest, Supertest, `mongodb-memory-server` (self-contained, zero-setup test database).

---

## 3. Getting Started

### Prerequisites
- Node.js `>=22.0.0` (Use `.nvmrc`: `nvm use`)
- npm `>=10.0.0`
- Optional: Docker Desktop (for running MongoDB locally)

### Installation
Clone the repository and install all dependencies across the workspace:

```bash
git clone https://github.com/balaji-aadi/CollabSync.git
cd CollabSync
npm install
```

### Environment Configuration
Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Default variables are configured for local development:
```env
PORT=5005
NODE_ENV=development
CLIENT_ORIGIN=http://localhost:5173
MONGODB_URI=mongodb://localhost:27017/collabsync
JWT_SECRET=development_secret_key_at_least_32_characters_long_min
JWT_EXPIRES_IN=7d
COOKIE_NAME=collabsync_token
```

### Running MongoDB
Launch the MongoDB container locally via Docker Compose:

```bash
docker compose up -d
```

### Running the Application

```bash
# Run both client and server concurrently in development mode:
npm run dev

# Or run services individually:
npm run dev:server   # Starts Express backend on http://localhost:5005
npm run dev:client   # Starts Vite React frontend on http://localhost:5173
```

Visit `http://localhost:5173` in your browser.

---

## 4. Real-Time Socket Channels & Events

### Document Lifecycle & Synchronization
- `join-document { docId, stateVector? }` — Authorizes access, restores persisted state from MongoDB on first load, sends `initial-state`, server `sync-step-1` vector, `save-status`, and existing room awareness.
- `sync-step-1 { docId, stateVector }` — Peer requests missing diff relative to its state vector. Server calculates and returns `sync-step-2`.
- `sync-step-2 { docId, update }` — Peer delivers missing differential CRDT updates. Server applies and relays to peers.
- `document-update { docId, update }` — Relays real-time CRDT updates to peers in room without echoing; marks room dirty and schedules write-behind persistence.
- `flush-document { docId }` — Manually triggers immediate persistence flush to MongoDB (e.g. for save retry).
- `leave-document { docId }` — Leaves document room.

### Live Ephemeral Awareness & Cursors
- `awareness-update { docId, update }` — Relays peer cursor positions, selections, and user identities. Never persisted to database.
- `user-joined` / `user-left` — Real-time peer arrival and departure notifications.

### Status & Management
- `save-status { docId, status, lastSavedAt, error }` — Broadcasts real-time persistence state (`'saving' | 'saved' | 'error'`).
- `document-renamed { docId, title }` — Real-time document title synchronization.
- `document-error { code, message }` — Protocol or authorization errors (e.g. `ACCESS_REVOKED`).

---

## 5. Automated Tests

CollabSync includes 58 automated tests that run against real Express handlers, live Socket.IO client connections, and an in-memory MongoDB runner (`mongodb-memory-server`, requiring no external database).

```bash
# Run full test suite:
npm run test

# Run tests with coverage:
npm run test:coverage

# Typecheck full workspace:
npm run typecheck

# Build both client and server for production:
npm run build
```

---

## 6. Persistence Guarantees & Known Boundaries

- **Durable Snapshot Persistence:** Document content is saved to MongoDB as a compacted Yjs update (`contentBinary: Buffer`) with `{ writeConcern: { w: 'majority' } }` using a debounced write-behind strategy (1500ms delay).
- **Restart Reconstitution:** When the server restarts or an evicted room is reopened, the authoritative `contentBinary` is loaded from MongoDB before client edits are accepted.
- **Eviction & Shutdown Safety:** Pending writes in RAM are awaited (`flushPersistence`) before room destruction or server shutdown (`SIGTERM`/`SIGINT`).
- **Single-Node Architecture:** Room coordination currently runs on a single Node.js instance. Multi-node clustering with a Redis Pub/Sub adapter is reserved for future horizontal scaling.
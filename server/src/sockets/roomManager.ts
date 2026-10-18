import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { DocumentModel } from '../models/Document.js';

export interface RoomState {
  docId: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  activeSockets: Set<string>;
  socketAwarenessClients: Map<string, Set<number>>;
  clientToSocket: Map<number, string>;
  createdAt: Date;
  lastActiveAt: Date;
  isInitialized: boolean;
  initPromise: Promise<void> | null;
  version: number;
  lastSavedVersion: number;
  dirty: boolean;
  saveTimer: NodeJS.Timeout | null;
  savePromise: Promise<boolean> | null;
  lastSavedAt?: Date;
}

export type SaveStatusType = 'saving' | 'saved' | 'error';
export type SaveStatusListener = (
  docId: string,
  status: SaveStatusType,
  lastSavedAt?: Date,
  errorMsg?: string
) => void;

export class RoomManager {
  private rooms: Map<string, RoomState> = new Map();
  private idleTimers: Map<string, NodeJS.Timeout> = new Map();
  private idleTimeoutMs: number;
  private saveDebounceMs: number;
  private saveStatusListeners: SaveStatusListener[] = [];

  /**
   * @param idleTimeoutMs Milliseconds before an empty room is evicted from memory (default: 10 minutes)
   * @param saveDebounceMs Milliseconds to debounce write-behind persistence (default: 1500ms)
   */
  constructor(idleTimeoutMs: number = 10 * 60 * 1000, saveDebounceMs: number = 1500) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.saveDebounceMs = saveDebounceMs;
  }

  /**
   * Register a listener for persistence save status transitions
   */
  public onSaveStatus(listener: SaveStatusListener): () => void {
    this.saveStatusListeners.push(listener);
    return () => {
      this.saveStatusListeners = this.saveStatusListeners.filter((l) => l !== listener);
    };
  }

  private notifySaveStatus(
    docId: string,
    status: SaveStatusType,
    lastSavedAt?: Date,
    errorMsg?: string
  ): void {
    for (const listener of this.saveStatusListeners) {
      try {
        listener(docId, status, lastSavedAt, errorMsg);
      } catch (err) {
        console.error('[RoomManager] Error in save-status listener:', err);
      }
    }
  }

  /**
   * Set custom idle timeout (primarily for testing)
   */
  public setIdleTimeout(ms: number): void {
    this.idleTimeoutMs = ms;
  }

  /**
   * Set custom save debounce delay (primarily for testing)
   */
  public setSaveDebounce(ms: number): void {
    this.saveDebounceMs = ms;
  }

  /**
   * Get an existing room or initialize a synchronous placeholder in memory
   */
  public getOrCreateRoom(docId: string): RoomState {
    // If an eviction timer is pending for this room, cancel it because room is being accessed
    const existingTimer = this.idleTimers.get(docId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.idleTimers.delete(docId);
    }

    let room = this.rooms.get(docId);
    if (!room) {
      const ydoc = new Y.Doc();
      const awareness = new Awareness(ydoc);
      room = {
        docId,
        ydoc,
        awareness,
        activeSockets: new Set<string>(),
        socketAwarenessClients: new Map<string, Set<number>>(),
        clientToSocket: new Map<number, string>(),
        createdAt: new Date(),
        lastActiveAt: new Date(),
        isInitialized: false,
        initPromise: null,
        version: 0,
        lastSavedVersion: 0,
        dirty: false,
        saveTimer: null,
        savePromise: null,
      };
      this.rooms.set(docId, room);
    } else {
      room.lastActiveAt = new Date();
    }
    return room;
  }

  /**
   * Asynchronously initialize room from MongoDB if it has persisted state
   */
  public async initializeRoom(docId: string): Promise<RoomState> {
    const room = this.getOrCreateRoom(docId);
    if (room.isInitialized) {
      return room;
    }

    if (room.initPromise) {
      await room.initPromise;
      return room;
    }

    room.initPromise = (async () => {
      try {
        const doc = await DocumentModel.findById(docId).select('contentBinary lastSavedAt');
        if (doc && doc.contentBinary && doc.contentBinary.length > 0) {
          Y.applyUpdate(room.ydoc, new Uint8Array(doc.contentBinary), 'mongo-init');
          if (doc.lastSavedAt) {
            room.lastSavedAt = doc.lastSavedAt;
          }
        }
        room.isInitialized = true;
        room.dirty = false;
        room.version = 0;
        room.lastSavedVersion = 0;
      } catch (err: any) {
        console.error(`[RoomManager] Failed to load document ${docId} from MongoDB:`, err.message);
        room.isInitialized = true;
      } finally {
        room.initPromise = null;
      }
    })();

    await room.initPromise;
    return room;
  }

  /**
   * Register a socket into a document room
   */
  public addSocket(docId: string, socketId: string): RoomState {
    const room = this.getOrCreateRoom(docId);
    room.activeSockets.add(socketId);
    room.lastActiveAt = new Date();
    return room;
  }

  /**
   * Remove a socket from a document room.
   * If the room becomes empty, schedules idle eviction after idleTimeoutMs.
   */
  public removeSocket(docId: string, socketId: string): void {
    const room = this.rooms.get(docId);
    if (room) {
      room.activeSockets.delete(socketId);
      this.removeSocketAwareness(docId, socketId);
      room.lastActiveAt = new Date();

      // If room is empty, schedule eviction to avoid unbounded memory growth
      if (room.activeSockets.size === 0 && !this.idleTimers.has(docId)) {
        const timer = setTimeout(async () => {
          // Verify timer is still active and registered for this document
          if (this.idleTimers.get(docId) !== timer) {
            return;
          }

          const currentRoom = this.rooms.get(docId);
          if (!currentRoom || currentRoom.activeSockets.size > 0) {
            this.idleTimers.delete(docId);
            return;
          }

          // Ensure any pending dirty state is committed to MongoDB before destroying room
          if (currentRoom.dirty) {
            try {
              await this.flushPersistence(docId);
            } catch (err: any) {
              console.error(`[RoomManager] Error flushing before eviction for ${docId}:`, err.message);
            }
          }

          // CRITICAL POST-AWAIT RE-CHECKS (CRIT-01):
          // While flushPersistence was awaiting MongoDB network I/O, a client may have reconnected,
          // joined the room, or added edits, or the timer may have been cancelled.
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

          // If new edits arrived during the flush that left the room dirty, abort eviction and reschedule
          if (currentRoom.dirty) {
            this.idleTimers.delete(docId);
            if (currentRoom.activeSockets.size === 0) {
              this.removeSocket(docId, '');
            }
            return;
          }

          // Atomic cleanup: remove from registry before destroying internal state
          this.idleTimers.delete(docId);
          this.rooms.delete(docId);
          currentRoom.awareness.destroy();
          currentRoom.ydoc.destroy();
        }, this.idleTimeoutMs);
        this.idleTimers.set(docId, timer);
      }
    }
  }

  /**
   * Remove a socket from all rooms it joined (e.g. on disconnect)
   */
  public removeSocketFromAll(socketId: string): string[] {
    const affectedRooms: string[] = [];
    for (const [docId, room] of this.rooms.entries()) {
      if (room.activeSockets.has(socketId)) {
        this.removeSocket(docId, socketId);
        affectedRooms.push(docId);
      }
    }
    return affectedRooms;
  }

  /**
   * Apply an incoming binary Yjs update to the room's Y.Doc and schedule persistence
   */
  public applyUpdate(docId: string, update: Uint8Array, origin?: any): void {
    const room = this.getOrCreateRoom(docId);
    room.lastActiveAt = new Date();
    Y.applyUpdate(room.ydoc, update, origin);

    // Monotonic version increment and dirty marking
    room.version++;
    room.dirty = true;
    this.notifySaveStatus(docId, 'saving');
    this.schedulePersistence(docId);
  }

  /**
   * Schedule debounced write-behind persistence
   */
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

  /**
   * Immediately flush any pending updates for a document to MongoDB
   */
  public async flushPersistence(docId: string): Promise<boolean> {
    const room = this.rooms.get(docId);
    if (!room) return true;

    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }

    // Wait if an existing save operation is in-flight
    if (room.savePromise) {
      await room.savePromise;
    }

    if (!room.dirty) {
      return true;
    }

    const snapshotVersion = room.version;
    const snapshot = Y.encodeStateAsUpdate(room.ydoc);

    room.savePromise = (async () => {
      try {
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

        if (!result.acknowledged || result.matchedCount === 0) {
          throw new Error(
            `Document ${docId} persistence unacknowledged or not found in database (matchedCount: ${result.matchedCount})`
          );
        }

        room.lastSavedAt = now;

        if (room.version === snapshotVersion) {
          room.dirty = false;
          room.lastSavedVersion = snapshotVersion;
          this.notifySaveStatus(docId, 'saved', now);
        } else {
          // Newer updates were applied while asynchronous write was in-flight; reschedule save
          this.schedulePersistence(docId, 300);
        }
        return true;
      } catch (err: any) {
        console.error(`[RoomManager] Failed to persist doc ${docId} to MongoDB:`, err.message);
        this.notifySaveStatus(docId, 'error', undefined, err.message);
        // Exponential backoff retry
        this.schedulePersistence(docId, 2500);
        return false;
      } finally {
        room.savePromise = null;
      }
    })();

    return room.savePromise;
  }

  /**
   * Flush all dirty rooms to MongoDB concurrently (e.g. before graceful shutdown)
   */
  public async flushAll(): Promise<void> {
    const tasks: Promise<boolean>[] = [];
    for (const [docId, room] of this.rooms.entries()) {
      if (room.dirty) {
        tasks.push(this.flushPersistence(docId));
      }
    }
    await Promise.all(tasks);
  }

  /**
   * Get the complete current compiled binary state of the document
   */
  public getCurrentState(docId: string): Uint8Array {
    const room = this.getOrCreateRoom(docId);
    return Y.encodeStateAsUpdate(room.ydoc);
  }

  /**
   * Check if a room exists in memory
   */
  public hasRoom(docId: string): boolean {
    return this.rooms.has(docId);
  }

  /**
   * Check if a room has unpersisted changes
   */
  public isDirty(docId: string): boolean {
    return this.rooms.get(docId)?.dirty ?? false;
  }

  /**
   * Get room socket count
   */
  public getRoomSize(docId: string): number {
    return this.rooms.get(docId)?.activeSockets.size ?? 0;
  }

  /**
   * Get room state by docId
   */
  public getRoom(docId: string): RoomState | undefined {
    return this.rooms.get(docId);
  }

  /**
   * Check if a socket is active in a specific room
   */
  public hasSocket(docId: string, socketId: string): boolean {
    return this.rooms.get(docId)?.activeSockets.has(socketId) ?? false;
  }

  /**
   * Get all room IDs that a given socket is currently active in
   */
  public getRoomsForSocket(socketId: string): string[] {
    const matched: string[] = [];
    for (const [docId, room] of this.rooms.entries()) {
      if (room.activeSockets.has(socketId)) {
        matched.push(docId);
      }
    }
    return matched;
  }

  /**
   * Register awareness client IDs for a socket in a document room.
   * Discards any client ID that is already registered to a different active socket (anti-spoofing).
   * Returns the list of accepted client IDs.
   */
  public registerSocketAwareness(
    docId: string,
    socketId: string,
    candidateClientIds: number[]
  ): number[] {
    const room = this.rooms.get(docId);
    if (!room) return [];

    let socketClients = room.socketAwarenessClients.get(socketId);
    if (!socketClients) {
      socketClients = new Set<number>();
      room.socketAwarenessClients.set(socketId, socketClients);
    }

    const accepted: number[] = [];
    for (const cid of candidateClientIds) {
      const existingOwner = room.clientToSocket.get(cid);
      if (existingOwner && existingOwner !== socketId && room.activeSockets.has(existingOwner)) {
        // Client ID already owned by another active socket; discard to prevent hijacking
        continue;
      }
      room.clientToSocket.set(cid, socketId);
      socketClients.add(cid);
      accepted.push(cid);
    }

    return accepted;
  }

  /**
   * Unregister and return all awareness client IDs associated with a socket in a room.
   */
  public removeSocketAwareness(docId: string, socketId: string): number[] {
    const room = this.rooms.get(docId);
    if (!room) return [];

    const socketClients = room.socketAwarenessClients.get(socketId);
    if (!socketClients || socketClients.size === 0) {
      room.socketAwarenessClients.delete(socketId);
      return [];
    }

    const evicted = Array.from(socketClients);
    for (const cid of evicted) {
      room.clientToSocket.delete(cid);
    }
    room.socketAwarenessClients.delete(socketId);
    return evicted;
  }

  /**
   * Destroy a specific room immediately after flushing
   */
  public async destroyRoom(docId: string): Promise<void> {
    const timer = this.idleTimers.get(docId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(docId);
    }
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
  }

  /**
   * Clear all rooms and timers without persisting (for test isolation)
   */
  public clearAllRooms(): void {
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    for (const room of this.rooms.values()) {
      if (room.saveTimer) {
        clearTimeout(room.saveTimer);
      }
      room.awareness.destroy();
      room.ydoc.destroy();
    }
    this.rooms.clear();
  }
}

// Export singleton instance with 10-minute idle eviction policy and 1500ms save debounce
export const roomManager = new RoomManager();

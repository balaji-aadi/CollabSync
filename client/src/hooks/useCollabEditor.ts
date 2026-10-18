import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import * as Y from 'yjs';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from 'y-protocols/awareness';

export interface CollabUser {
  id: string;
  name: string;
  email?: string;
  color?: string;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type SaveStatus = 'saved' | 'saving' | 'error';

const USER_COLORS = [
  '#f43f5e', // rose
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#3b82f6', // blue
  '#14b8a6', // teal
];

function getUserColor(userId?: string): string {
  if (!userId) return USER_COLORS[0];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

export function useCollabEditor(
  docId: string,
  onDocumentRenamed?: (newTitle: string) => void,
  currentUser?: { id: string; name: string; email?: string } | null
) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [activeUsers, setActiveUsers] = useState<CollabUser[]>([]);

  // State-held Y.Doc & Awareness instances that guarantee clean lifecycle across React 18 mounts/remounts
  const [ydoc, setYdoc] = useState<Y.Doc>(() => new Y.Doc());
  const [awareness, setAwareness] = useState<Awareness>(() => new Awareness(ydoc));
  const socketRef = useRef<Socket | null>(null);
  const onDocumentRenamedRef = useRef(onDocumentRenamed);

  useEffect(() => {
    onDocumentRenamedRef.current = onDocumentRenamed;
  }, [onDocumentRenamed]);

  useEffect(() => {
    let isDisposed = false;

    // Instantiate a fresh, active Y.Doc and Awareness instance for this session
    const currentYdoc = new Y.Doc();
    const currentAwareness = new Awareness(currentYdoc);
    setYdoc(currentYdoc);
    setAwareness(currentAwareness);

    setStatus('connecting');
    setErrorMessage(null);
    setSaveStatus('saved');

    // Configure local awareness state with user identity and color
    const userColor = getUserColor(currentUser?.id);
    currentAwareness.setLocalStateField('user', {
      name: currentUser?.name || 'Anonymous User',
      color: userColor,
    });

    // Initialize Socket.IO connection
    const socket = io({
      path: '/socket.io',
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });
    socketRef.current = socket;

    // Handle connection & reconnection (Phase 2.3: sends state vector for differential sync)
    socket.on('connect', () => {
      if (isDisposed) return;
      const localStateVector = Y.encodeStateVector(currentYdoc);
      socket.emit('join-document', {
        docId,
        stateVector: Array.from(localStateVector),
      });
    });

    // Handle initial state from server
    socket.on('initial-state', (payload: { docId: string; update: ArrayBuffer | number[] | Uint8Array }) => {
      if (isDisposed || payload.docId !== docId) return;
      try {
        const updateArray = new Uint8Array(payload.update);
        if (updateArray.length > 0) {
          Y.applyUpdate(currentYdoc, updateArray, 'socket');
        }
        setStatus('connected');
      } catch (err: any) {
        console.error('[CollabEditor] Failed to apply initial state:', err);
        setStatus('error');
        setErrorMessage('Failed to load initial document state');
      }
    });

    // Handle Yjs Sync Step 1 (Server requested local diff relative to server's state vector)
    socket.on('sync-step-1', (payload: { docId: string; stateVector: ArrayBuffer | number[] | Uint8Array }) => {
      if (isDisposed || payload.docId !== docId) return;
      try {
        const serverVector = new Uint8Array(payload.stateVector);
        const localDiff = Y.encodeStateAsUpdate(currentYdoc, serverVector);
        if (localDiff.length > 0) {
          socket.emit('sync-step-2', {
            docId,
            update: Array.from(localDiff),
          });
        }
      } catch (err: any) {
        console.error('[CollabEditor] Failed to compute sync-step-1 diff:', err);
      }
    });

    // Handle Yjs Sync Step 2 (Server sent differential catch-up update)
    socket.on('sync-step-2', (payload: { docId: string; update: ArrayBuffer | number[] | Uint8Array }) => {
      if (isDisposed || payload.docId !== docId) return;
      try {
        const updateArray = new Uint8Array(payload.update);
        if (updateArray.length > 0) {
          Y.applyUpdate(currentYdoc, updateArray, 'socket');
        }
        setStatus('connected');
      } catch (err: any) {
        console.error('[CollabEditor] Failed to apply sync-step-2 update:', err);
      }
    });

    // Handle incoming updates from other peers
    socket.on('document-update', (payload: { docId: string; update: ArrayBuffer | number[] | Uint8Array }) => {
      if (isDisposed || payload.docId !== docId) return;
      try {
        const updateArray = new Uint8Array(payload.update);
        Y.applyUpdate(currentYdoc, updateArray, 'socket');
      } catch (err: any) {
        console.error('[CollabEditor] Failed to apply document update:', err);
      }
    });

    // Handle awareness updates from peers (cursors, presence)
    socket.on('awareness-update', (payload: { docId: string; update: ArrayBuffer | number[] | Uint8Array }) => {
      if (isDisposed || payload.docId !== docId) return;
      try {
        const updateArray = new Uint8Array(payload.update);
        applyAwarenessUpdate(currentAwareness, updateArray, 'socket');
      } catch (err: any) {
        console.error('[CollabEditor] Failed to apply awareness update:', err);
      }
    });

    // Handle real-time persistence save status from server
    socket.on('save-status', (payload: { docId: string; status: SaveStatus; lastSavedAt?: string; error?: string }) => {
      if (isDisposed || payload.docId !== docId) return;
      setSaveStatus(payload.status);
      if (payload.lastSavedAt) {
        setLastSavedAt(new Date(payload.lastSavedAt));
      }
      if (payload.error) {
        setErrorMessage(payload.error);
      }
    });

    // Handle real-time document rename from peers
    socket.on('document-renamed', (payload: { docId: string; title: string }) => {
      if (isDisposed || payload.docId !== docId) return;
      if (onDocumentRenamedRef.current) {
        onDocumentRenamedRef.current(payload.title);
      }
    });

    // Handle user presence events
    socket.on('user-joined', (payload: { docId: string; user: CollabUser }) => {
      if (isDisposed || payload.docId !== docId) return;
      setActiveUsers((prev) => {
        if (prev.some((u) => u.id === payload.user.id)) return prev;
        return [...prev, payload.user];
      });
    });

    socket.on('user-left', (payload: { docId: string; user: CollabUser }) => {
      if (isDisposed || payload.docId !== docId) return;
      setActiveUsers((prev) => prev.filter((u) => u.id !== payload.user.id));
    });

    let isRevoked = false;

    // Handle errors (including ACCESS_REVOKED)
    socket.on('document-error', (err: { code: string; message: string }) => {
      if (isDisposed) return;
      if (err.code === 'ACCESS_REVOKED' || err.code === 'FORBIDDEN') {
        isRevoked = true;
      }
      setStatus('error');
      setErrorMessage(err.message || 'Collaboration error');
    });

    socket.on('connect_error', (err) => {
      if (isDisposed) return;
      setStatus('disconnected');
      setErrorMessage(err.message || 'Failed to connect to collaboration server');
    });

    socket.on('disconnect', () => {
      if (isDisposed) return;
      setStatus('disconnected');
    });

    // Listen for local changes from TipTap editor
    const updateHandler = (update: Uint8Array, origin: any) => {
      if (origin !== 'socket' && socket.connected && !isRevoked) {
        socket.emit('document-update', {
          docId,
          update: Array.from(update),
        });
      }
    };
    currentYdoc.on('update', updateHandler);

    // Listen for local awareness changes (cursor / selection)
    const awarenessUpdateHandler = ({ added, updated, removed }: any, origin: any) => {
      if (origin !== 'socket' && socket.connected && !isRevoked) {
        const changedClients = added.concat(updated).concat(removed);
        const encodedUpdate = encodeAwarenessUpdate(currentAwareness, changedClients);
        socket.emit('awareness-update', {
          docId,
          update: Array.from(encodedUpdate),
        });
      }
    };
    currentAwareness.on('update', awarenessUpdateHandler);

    // Cleanup when component unmounts or document changes
    return () => {
      isDisposed = true;
      currentYdoc.off('update', updateHandler);
      currentAwareness.off('update', awarenessUpdateHandler);

      if (socket.connected) {
        socket.emit('leave-document', { docId });
      }
      socket.disconnect();
      socketRef.current = null;
      currentAwareness.destroy();
      currentYdoc.destroy();
    };
  }, [docId, currentUser?.id, currentUser?.name]);

  const retrySave = () => {
    if (socketRef.current?.connected) {
      setSaveStatus('saving');
      socketRef.current.emit('flush-document', { docId });
    }
  };

  return {
    ydoc,
    awareness,
    status,
    saveStatus,
    lastSavedAt,
    errorMessage,
    activeUsers,
    retrySave,
  };
}

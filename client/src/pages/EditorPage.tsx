import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { DocumentItem, fetchDocument, renameDocument, addCollaborator, removeCollaborator } from '../api/documents';
import { useCollabEditor } from '../hooks/useCollabEditor';
import { TipTapEditor } from '../components/TipTapEditor';
import { StatusBadge } from '../components/StatusBadge';
import { ShareModal } from '../components/ShareModal';
import {
  ArrowLeft,
  Share2,
  Users,
  Edit2,
  Check,
  X,
  AlertTriangle,
  Info,
  Shield,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';

interface EditorPageProps {
  docId: string;
  onBack: () => void;
}

export const EditorPage: React.FC<EditorPageProps> = ({ docId, onBack }) => {
  const { user: currentUser } = useAuth();
  const [docMetadata, setDocMetadata] = useState<DocumentItem | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // In-place title renaming
  const [isRenaming, setIsRenaming] = useState(false);
  const [titleInput, setTitleInput] = useState('');

  // Share modal state
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);

  // Handle real-time rename from other collaborators
  const handleRemoteRename = (newTitle: string) => {
    setDocMetadata((prev) => (prev ? { ...prev, title: newTitle } : null));
    setTitleInput(newTitle);
  };

  // Hook into Yjs collaborative synchronization, differential sync, awareness, and save status
  const {
    ydoc,
    awareness,
    status,
    saveStatus,
    lastSavedAt,
    errorMessage,
    activeUsers,
    retrySave,
  } = useCollabEditor(docId, handleRemoteRename, currentUser);

  // Fetch initial document metadata from REST API
  useEffect(() => {
    let isMounted = true;
    async function loadMeta() {
      setIsLoading(true);
      setLoadError(null);
      try {
        const data = await fetchDocument(docId);
        if (isMounted) {
          setDocMetadata(data.document);
          setIsOwner(data.isOwner);
          setTitleInput(data.document.title);
        }
      } catch (err: any) {
        if (isMounted) {
          setLoadError(err.message || 'Failed to load document metadata');
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }
    loadMeta();
    return () => {
      isMounted = false;
    };
  }, [docId]);

  const handleRename = async () => {
    if (!titleInput.trim() || !docMetadata) return;
    try {
      const updated = await renameDocument(docId, titleInput.trim());
      setDocMetadata(updated);
      setIsRenaming(false);
    } catch (err: any) {
      alert(err.message || 'Failed to rename document');
    }
  };

  const handleAddCollaborator = async (email: string) => {
    const updated = await addCollaborator(docId, email);
    setDocMetadata(updated);
  };

  const handleRemoveCollaborator = async (collaboratorUserId: string) => {
    const updated = await removeCollaborator(docId, collaboratorUserId);
    setDocMetadata(updated);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center space-y-4">
        <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-slate-400">Loading collaborative workspace...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full bg-slate-950 border border-slate-800 rounded-2xl p-6 text-center space-y-4 shadow-xl">
          <div className="w-12 h-12 bg-rose-500/10 text-rose-400 rounded-xl flex items-center justify-center mx-auto">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-bold text-white">Access Denied or Not Found</h2>
          <p className="text-sm text-slate-400">{loadError}</p>
          <button
            onClick={onBack}
            className="inline-flex items-center space-x-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm font-medium transition"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Return to Dashboard</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-30 px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center space-x-3 flex-1 min-w-0">
          <button
            onClick={onBack}
            title="Back to dashboard"
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          {/* Title Area */}
          <div className="flex items-center space-x-2 min-w-0">
            {isRenaming ? (
              <div className="flex items-center space-x-1.5">
                <input
                  type="text"
                  autoFocus
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename();
                    if (e.key === 'Escape') setIsRenaming(false);
                  }}
                  className="bg-slate-950 border border-indigo-500 rounded-lg px-2.5 py-1 text-sm font-semibold text-white focus:outline-none"
                />
                <button
                  onClick={handleRename}
                  className="p-1 text-emerald-400 hover:bg-emerald-500/10 rounded"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setIsRenaming(false)}
                  className="p-1 text-slate-400 hover:bg-slate-800 rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center space-x-2 group cursor-pointer" onClick={() => setIsRenaming(true)}>
                <h1 className="text-base sm:text-lg font-bold text-white truncate group-hover:text-indigo-300 transition-colors">
                  {docMetadata?.title || 'Untitled Document'}
                </h1>
                <Edit2 className="w-3.5 h-3.5 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            )}

            {isOwner && (
              <span className="hidden md:inline-flex items-center space-x-1 text-xs text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded border border-amber-400/20 font-medium">
                <Shield className="w-3 h-3" />
                <span>Owner</span>
              </span>
            )}
          </div>
        </div>

        {/* Status and Action Buttons */}
        <div className="flex items-center space-x-3">
          {/* Real-Time Persistence Save Status */}
          {saveStatus === 'saved' && (
            <div
              title={lastSavedAt ? `Saved to MongoDB at ${lastSavedAt.toLocaleTimeString()}` : 'Saved to MongoDB'}
              className="hidden sm:inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Saved</span>
            </div>
          )}

          {saveStatus === 'saving' && (
            <div className="hidden sm:inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-400">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Saving...</span>
            </div>
          )}

          {saveStatus === 'error' && (
            <button
              onClick={retrySave}
              title="Database write failed. Click to retry persistence."
              className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/30 text-xs text-rose-400 hover:bg-rose-500/20 transition cursor-pointer font-medium"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Save Failed — Retry</span>
            </button>
          )}

          <StatusBadge status={status} />

          {/* Active Collaborators count */}
          {activeUsers.length > 0 && (
            <div className="hidden sm:flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-slate-800/80 border border-slate-700 text-xs text-slate-300">
              <Users className="w-3.5 h-3.5 text-indigo-400" />
              <span>{activeUsers.length} active</span>
            </div>
          )}

          {/* Share Button */}
          <button
            onClick={() => setIsShareModalOpen(true)}
            className="flex items-center space-x-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs sm:text-sm font-medium transition shadow-md shadow-indigo-600/20"
          >
            <Share2 className="w-3.5 h-3.5" />
            <span>Share</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6 space-y-4">
        {/* Phase 2 Explanatory Notification Banner */}
        <div className="p-3.5 rounded-xl bg-slate-800/40 border border-slate-700/60 text-xs text-slate-300 flex items-start space-x-3">
          <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold text-slate-200">Phase 2 Durable Persistence & Live Cursors Active: </span>
            Edits synchronize in real time via Yjs CRDTs and are durably persisted to MongoDB with debounced write-behind snapshots.
            <span className="text-slate-400 block sm:inline sm:ml-1">
              Collaborator cursors and presence update ephemerally without polluting database storage.
            </span>
          </div>
        </div>

        {/* Error notification if socket disconnected or room error */}
        {errorMessage && (
          <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-400 flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* TipTap + Yjs Collaborative Editor with Live Cursors */}
        <TipTapEditor
          ydoc={ydoc}
          awareness={awareness}
          currentUser={currentUser}
          editable={status === 'connected' || status === 'connecting'}
        />
      </main>

      {/* Share & Access Management Modal */}
      {docMetadata && (
        <ShareModal
          isOpen={isShareModalOpen}
          onClose={() => setIsShareModalOpen(false)}
          owner={docMetadata.owner}
          collaborators={docMetadata.collaborators || []}
          isOwner={isOwner}
          onAddCollaborator={handleAddCollaborator}
          onRemoveCollaborator={handleRemoveCollaborator}
        />
      )}
    </div>
  );
};

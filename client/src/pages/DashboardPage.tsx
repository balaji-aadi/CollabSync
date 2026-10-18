import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { DocumentItem, fetchDocuments, createDocument, renameDocument } from '../api/documents';
import { Navbar } from '../components/Navbar';
import { CreateDocModal } from '../components/CreateDocModal';
import {
  FileText,
  Plus,
  Users,
  Clock,
  Edit2,
  Check,
  X,
  Search,
  Sparkles,
  Shield,
} from 'lucide-react';

interface DashboardPageProps {
  onOpenDoc: (docId: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onOpenDoc }) => {
  const { user } = useAuth();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // In-place rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');

  const loadDocuments = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const docs = await fetchDocuments();
      setDocuments(docs);
    } catch (err: any) {
      setError(err.message || 'Failed to load documents');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadDocuments();
  }, []);

  const handleCreateDocument = async (title: string) => {
    const newDoc = await createDocument(title);
    setDocuments((prev) => [newDoc, ...prev]);
    onOpenDoc(newDoc._id);
  };

  const startRename = (doc: DocumentItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingId(doc._id);
    setRenameTitle(doc.title);
  };

  const submitRename = async (id: string, e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!renameTitle.trim()) return;

    try {
      const updated = await renameDocument(id, renameTitle.trim());
      setDocuments((prev) => prev.map((d) => (d._id === id ? updated : d)));
      setRenamingId(null);
    } catch (err: any) {
      alert(err.message || 'Failed to rename document');
    }
  };

  const cancelRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingId(null);
  };

  const filteredDocs = documents.filter((doc) =>
    doc.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col">
      <Navbar onNewDoc={() => setIsCreateModalOpen(true)} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header / Banner */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight flex items-center gap-2">
              <span>Your Documents</span>
              <Sparkles className="w-5 h-5 text-indigo-400" />
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Collaborative workspaces powered by Yjs CRDT synchronization
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Search Input */}
            <div className="relative flex-1 sm:w-64">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search documents..."
                className="w-full bg-slate-950/80 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
              />
            </div>

            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-medium transition flex items-center space-x-1.5 shadow-lg shadow-indigo-600/20 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span>New Document</span>
            </button>
          </div>
        </div>

        {/* Content Area */}
        {isLoading ? (
          <div className="py-20 flex flex-col items-center justify-center space-y-3">
            <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-slate-400">Loading documents...</p>
          </div>
        ) : error ? (
          <div className="p-6 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-center max-w-md mx-auto my-12">
            <p className="text-sm text-rose-400 mb-3">{error}</p>
            <button
              onClick={loadDocuments}
              className="px-4 py-1.5 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 text-xs font-medium rounded-lg transition"
            >
              Retry
            </button>
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="text-center py-20 bg-slate-950/30 rounded-3xl border border-slate-800/60 p-8 max-w-lg mx-auto">
            <div className="w-14 h-14 bg-indigo-600/10 text-indigo-400 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-indigo-500/20">
              <FileText className="w-7 h-7" />
            </div>
            <h3 className="text-lg font-semibold text-white">No documents found</h3>
            <p className="text-sm text-slate-400 mt-1 mb-6">
              {searchQuery
                ? 'No documents matched your search term.'
                : 'Create your first collaborative document to start editing in real-time.'}
            </p>
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-xl transition inline-flex items-center space-x-2 shadow-lg shadow-indigo-600/20"
            >
              <Plus className="w-4 h-4" />
              <span>Create Document</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filteredDocs.map((doc) => {
              const isOwner = doc.owner.id === user?.id || (doc.owner as any)._id === user?.id;
              const collaboratorCount = doc.collaborators?.length || 0;
              const isRenaming = renamingId === doc._id;

              return (
                <div
                  key={doc._id}
                  onClick={() => !isRenaming && onOpenDoc(doc._id)}
                  className="group bg-slate-950/50 hover:bg-slate-950/80 border border-slate-800/80 hover:border-indigo-500/50 rounded-2xl p-5 transition duration-200 cursor-pointer shadow-lg hover:shadow-indigo-500/5 flex flex-col justify-between"
                >
                  <div>
                    {/* Top Badges */}
                    <div className="flex items-center justify-between mb-3">
                      <span
                        className={`text-xs px-2.5 py-0.5 rounded-full font-medium flex items-center space-x-1 border ${
                          isOwner
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                        }`}
                      >
                        {isOwner ? (
                          <>
                            <Shield className="w-3 h-3" />
                            <span>Owner</span>
                          </>
                        ) : (
                          <>
                            <Users className="w-3 h-3" />
                            <span>Collaborator</span>
                          </>
                        )}
                      </span>

                      <div className="flex items-center space-x-1">
                        <button
                          onClick={(e) => startRename(doc, e)}
                          title="Rename document"
                          className="p-1 text-slate-500 hover:text-slate-300 hover:bg-slate-800 rounded-lg transition"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Title */}
                    {isRenaming ? (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center space-x-2 my-1"
                      >
                        <input
                          type="text"
                          autoFocus
                          value={renameTitle}
                          onChange={(e) => setRenameTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitRename(doc._id);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          className="flex-1 bg-slate-900 border border-indigo-500 rounded-lg px-2 py-1 text-sm text-white focus:outline-none"
                        />
                        <button
                          onClick={() => submitRename(doc._id)}
                          className="p-1 text-emerald-400 hover:bg-emerald-500/10 rounded"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={cancelRename}
                          className="p-1 text-slate-400 hover:bg-slate-800 rounded"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <h3 className="text-base font-semibold text-white group-hover:text-indigo-300 transition-colors line-clamp-2">
                        {doc.title}
                      </h3>
                    )}
                  </div>

                  {/* Card Meta Footer */}
                  <div className="mt-5 pt-3 border-t border-slate-800/60 flex items-center justify-between text-xs text-slate-400">
                    <div className="flex items-center space-x-1.5">
                      <Clock className="w-3.5 h-3.5 text-slate-500" />
                      <span>{new Date(doc.updatedAt).toLocaleDateString()}</span>
                    </div>

                    <div className="flex items-center space-x-1">
                      <Users className="w-3.5 h-3.5 text-slate-500" />
                      <span>{collaboratorCount + 1} participant{collaboratorCount > 0 ? 's' : ''}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      <CreateDocModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreate={handleCreateDocument}
      />
    </div>
  );
};

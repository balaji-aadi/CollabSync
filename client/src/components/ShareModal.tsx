import React, { useState } from 'react';
import { User } from '../api/auth';
import { X, UserPlus, Trash2, Shield, Users } from 'lucide-react';

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  owner: User;
  collaborators: User[];
  isOwner: boolean;
  onAddCollaborator: (email: string) => Promise<void>;
  onRemoveCollaborator: (userId: string) => Promise<void>;
}

export const ShareModal: React.FC<ShareModalProps> = ({
  isOpen,
  onClose,
  owner,
  collaborators,
  isOwner,
  onAddCollaborator,
  onRemoveCollaborator,
}) => {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await onAddCollaborator(email.trim());
      setEmail('');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to add collaborator');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemove = async (userId: string) => {
    try {
      await onRemoveCollaborator(userId);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to remove collaborator');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 text-indigo-400 flex items-center justify-center">
              <Users className="w-4 h-4" />
            </div>
            <h3 className="text-base font-semibold text-white">Document Access & Sharing</h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-6">
          {/* Add collaborator form (Owners only) */}
          {isOwner ? (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Invite Collaborator by Registered Email
              </label>
              <form onSubmit={handleSubmit} className="flex space-x-2">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="colleague@example.com"
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
                  disabled={isSubmitting}
                />
                <button
                  type="submit"
                  disabled={isSubmitting || !email.trim()}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl text-sm font-medium flex items-center space-x-1.5 transition"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>{isSubmitting ? 'Adding...' : 'Invite'}</span>
                </button>
              </form>
            </div>
          ) : (
            <div className="text-xs text-slate-400 bg-slate-800/40 p-3 rounded-xl border border-slate-800">
              Only the document owner can invite or remove collaborators.
            </div>
          )}

          {/* Error Message */}
          {errorMessage && (
            <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-lg">
              {errorMessage}
            </div>
          )}

          {/* Current Collaborators List */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              People with access
            </h4>

            {/* Owner Item */}
            <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/60">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-xs">
                  {owner?.name?.charAt(0).toUpperCase() || 'O'}
                </div>
                <div>
                  <div className="text-sm font-medium text-slate-200">{owner?.name || 'Owner'}</div>
                  <div className="text-xs text-slate-400">{owner?.email}</div>
                </div>
              </div>
              <span className="flex items-center space-x-1 text-xs font-medium text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded border border-amber-400/20">
                <Shield className="w-3 h-3" />
                <span>Owner</span>
              </span>
            </div>

            {/* Collaborators List */}
            {collaborators.length === 0 ? (
              <div className="text-xs text-slate-500 italic py-2 text-center">
                No external collaborators invited yet.
              </div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {collaborators.map((c) => (
                  <div
                    key={c.id || (c as any)._id}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/40 border border-slate-800/40"
                  >
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold text-xs">
                        {c.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-slate-200">{c.name}</div>
                        <div className="text-xs text-slate-400">{c.email}</div>
                      </div>
                    </div>
                    {isOwner && (
                      <button
                        onClick={() => handleRemove(c.id || (c as any)._id)}
                        className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition"
                        title="Remove collaborator"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 bg-slate-950/60 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium rounded-xl transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

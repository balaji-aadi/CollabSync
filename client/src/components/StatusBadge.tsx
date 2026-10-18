import React from 'react';
import { ConnectionStatus } from '../hooks/useCollabEditor';

interface StatusBadgeProps {
  status: ConnectionStatus;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const getStatusConfig = () => {
    switch (status) {
      case 'connected':
        return {
          color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
          dot: 'bg-emerald-400',
          label: 'Connected',
        };
      case 'connecting':
        return {
          color: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
          dot: 'bg-amber-400 animate-pulse',
          label: 'Connecting...',
        };
      case 'error':
        return {
          color: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
          dot: 'bg-rose-400',
          label: 'Error',
        };
      case 'disconnected':
      default:
        return {
          color: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
          dot: 'bg-slate-400',
          label: 'Disconnected',
        };
    }
  };

  const config = getStatusConfig();

  return (
    <div className="flex items-center space-x-2">
      <div className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${config.color}`}>
        <span className={`w-2 h-2 rounded-full ${config.dot}`} />
        <span>{config.label}</span>
      </div>
      <span className="hidden sm:inline-block text-xs text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700">
        Phase 1: In-Memory
      </span>
    </div>
  );
};

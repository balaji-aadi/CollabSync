import React from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { TipTapToolbar } from './TipTapToolbar';

interface TipTapEditorProps {
  ydoc: Y.Doc;
  awareness?: Awareness;
  currentUser?: { name: string; color?: string } | null;
  editable?: boolean;
}

export const TipTapEditor: React.FC<TipTapEditorProps> = ({
  ydoc,
  awareness,
  currentUser,
  editable = true,
}) => {
  const editor = useEditor(
    {
      editable,
      extensions: [
        // Disable local history since Yjs manages collaborative undo/redo
        StarterKit.configure({
          history: false,
        }),
        // Bind TipTap to shared Y.Doc
        Collaboration.configure({
          document: ydoc,
          field: 'default',
        }),
        // Bind TipTap to ephemeral collaborator live cursors and selections
        ...(awareness
          ? [
              CollaborationCursor.configure({
                provider: { awareness },
                user: {
                  name: currentUser?.name || 'Anonymous Peer',
                  color: currentUser?.color || '#8b5cf6',
                },
              }),
            ]
          : []),
      ],
      editorProps: {
        attributes: {
          class: 'focus:outline-none min-h-[450px]',
          'data-placeholder': 'Start typing your document... Collaborative updates synchronize instantly.',
        },
      },
    },
    [ydoc, awareness]
  );

  return (
    <div className="bg-slate-900/60 rounded-xl border border-slate-800 shadow-xl overflow-hidden focus-within:border-indigo-500/50 transition-colors">
      <TipTapToolbar editor={editor} />
      <div className="p-2 sm:p-4 bg-slate-950/40">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
};

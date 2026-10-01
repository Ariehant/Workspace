import { PAGE_CONTENT_FIELD } from '@workspace/core';
import Collaboration from '@tiptap/extension-collaboration';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect } from 'react';
import type * as Y from 'yjs';

export interface PageEditorProps {
  /** The page doc; content lives in its `PAGE_CONTENT_FIELD` XML fragment. */
  doc: Y.Doc;
  /** Called with the editor once it is ready, and with `null` on teardown. */
  onEditor?: (editor: Editor | null) => void;
}

/**
 * Rich-text body of a page, bound directly to the page's Yjs doc. Every keystroke
 * becomes a Yjs update, so persistence and (later) live collaboration need no extra
 * wiring. Undo history comes from Yjs, so it only undoes this user's own edits.
 */
export function PageEditor({ doc, onEditor }: PageEditorProps) {
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Placeholder.configure({ placeholder: 'Start writing…' }),
        Collaboration.configure({ document: doc, field: PAGE_CONTENT_FIELD }),
      ],
      editorProps: {
        attributes: { class: 'ws-prose', 'data-testid': 'page-editor', spellcheck: 'true' },
      },
    },
    [doc],
  );

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  return <EditorContent editor={editor} />;
}

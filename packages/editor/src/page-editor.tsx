import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect } from 'react';
import type * as Y from 'yjs';
import { BlockHandle } from './block-handle';
import { SelectionToolbar } from './bubble-menu';
import { pageExtensions } from './extensions';

export interface PageEditorProps {
  /** The page doc; its guid is the page id. */
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
      extensions: pageExtensions(doc),
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

  return (
    <>
      <EditorContent editor={editor} />
      {editor && <BlockHandle editor={editor} pageId={doc.guid} />}
      {editor && <SelectionToolbar editor={editor} />}
    </>
  );
}

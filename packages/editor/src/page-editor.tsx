import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { BlockHandle } from './block-handle';
import { SelectionToolbar } from './bubble-menu';
import { pageExtensions } from './extensions';
import { MathEditor, type MathTarget } from './math-editor';
import { TableMenu } from './nodes/table';
import { PagePicker } from './page-picker';
import {
  EditorServicesContext,
  UiBridgeHandle,
  type EditorServices,
  type PageRef,
} from './services';

export interface PageEditorProps {
  /** The page doc; its guid is the page id. */
  doc: Y.Doc;
  services: EditorServices;
  /** Called with the editor once it is ready, and with `null` on teardown. */
  onEditor?: (editor: Editor | null) => void;
}

interface PickRequest {
  anchor: DOMRect;
  resolve(page: PageRef | null): void;
}

/**
 * Rich-text body of a page, bound directly to the page's Yjs doc. Every keystroke
 * becomes a Yjs update, so persistence and (later) live collaboration need no extra
 * wiring. Undo history comes from Yjs, so it only undoes this user's own edits.
 */
export function PageEditor({ doc, services, onEditor }: PageEditorProps) {
  const [bridge] = useState(() => new UiBridgeHandle());
  const [pick, setPick] = useState<PickRequest | null>(null);
  const [math, setMath] = useState<MathTarget | null>(null);

  useEffect(() => {
    bridge.set({
      services,
      pickPage: (anchor) => new Promise((resolve) => setPick({ anchor, resolve })),
      editMath: (node, pos) => setMath({ node, pos }),
    });
  }, [bridge, services]);

  const editor = useEditor(
    {
      extensions: pageExtensions(doc, bridge),
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
    <EditorServicesContext.Provider value={services}>
      <EditorContent editor={editor} />
      {editor && <BlockHandle editor={editor} pageId={doc.guid} />}
      {editor && <SelectionToolbar editor={editor} />}
      {editor && <TableMenu editor={editor} />}
      {editor && math && <MathEditor editor={editor} target={math} onClose={() => setMath(null)} />}
      {pick && (
        <PagePicker
          services={services}
          anchor={pick.anchor}
          onPick={(page) => {
            pick.resolve(page);
            setPick(null);
          }}
        />
      )}
    </EditorServicesContext.Provider>
  );
}

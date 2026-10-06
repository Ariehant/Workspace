import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useCallback, useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { BlockHandle } from './block-handle';
import { SelectionToolbar } from './bubble-menu';
import { pageExtensions } from './extensions';
import { FindBar } from './find-bar';
import { MathEditor, type MathTarget } from './math-editor';
import { TableMenu } from './nodes/table';
import { PagePicker } from './page-picker';
import { PasteUrlMenu, type PastedUrl } from './paste-url-menu';
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
  /** `false` for locked pages: content can be read and copied but not changed. */
  editable?: boolean;
  /** Called with the editor once it is ready, and with `null` on teardown. */
  onEditor?: (editor: Editor | null) => void;
  /** Inside another editor (a synced block): the outer page's block handle is used. */
  nested?: boolean;
}

interface PickRequest {
  anchor: DOMRect;
  resolve(page: PageRef | null): void;
  databasesOnly?: boolean;
}

/**
 * Rich-text body of a page, bound directly to the page's Yjs doc. Every keystroke
 * becomes a Yjs update, so persistence and (later) live collaboration need no extra
 * wiring. Undo history comes from Yjs, so it only undoes this user's own edits.
 */
export function PageEditor({ doc, services, editable = true, onEditor, nested }: PageEditorProps) {
  const [bridge] = useState(() => new UiBridgeHandle());
  const [pick, setPick] = useState<PickRequest | null>(null);
  const [math, setMath] = useState<MathTarget | null>(null);
  const [pasted, setPasted] = useState<PastedUrl | null>(null);
  const [findOpen, setFindOpen] = useState(false);

  useEffect(() => {
    bridge.set({
      services,
      pastedUrl: (url, from, to) => setPasted({ url, from, to }),
      pickPage: (anchor, options) =>
        new Promise((resolve) =>
          setPick({ anchor, resolve, databasesOnly: options?.databasesOnly }),
        ),
      editMath: (node, pos) => setMath({ node, pos }),
      openFind: () => setFindOpen(true),
    });
  }, [bridge, services]);

  const closePasteMenu = useCallback(() => setPasted(null), []);

  const editor = useEditor(
    {
      extensions: pageExtensions(doc, bridge),
      editorProps: {
        attributes: { class: 'ws-prose', 'data-testid': 'page-editor', spellcheck: 'true' },
      },
    },
    [doc],
  );

  // Ctrl+F also works when focus is outside the editor (e.g. in the page title).
  useEffect(() => {
    // The outer page's find bar covers nested editors.
    if (nested) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === 'f'
      ) {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nested]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  return (
    <EditorServicesContext.Provider value={services}>
      <EditorContent editor={editor} />
      {editor && !nested && <BlockHandle editor={editor} pageId={doc.guid} />}
      {editor && <SelectionToolbar editor={editor} />}
      {editor && <TableMenu editor={editor} />}
      {editor && math && <MathEditor editor={editor} target={math} onClose={() => setMath(null)} />}
      {editor && pasted && (
        <PasteUrlMenu editor={editor} pasted={pasted} onClose={closePasteMenu} />
      )}
      {editor && findOpen && <FindBar editor={editor} onClose={() => setFindOpen(false)} />}
      {pick && (
        <PagePicker
          services={services}
          anchor={pick.anchor}
          databasesOnly={pick.databasesOnly}
          onPick={(page) => {
            pick.resolve(page);
            setPick(null);
          }}
        />
      )}
    </EditorServicesContext.Provider>
  );
}

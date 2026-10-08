import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useCallback, useEffect, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { BlockHandle } from './block-handle';
import { SelectionToolbar } from './bubble-menu';
import type { EditorComments } from './comments';
import { cursorsPlugin, cursorsPluginKey } from './cursors';
import { pageExtensions } from './extensions';
import { FindBar } from './find-bar';
import { MathEditor, type MathTarget } from './math-editor';
import { setMathMacros } from './nodes/math';
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
  /** Who else is on the page (their cursors show), and who you are (yours don't). */
  awareness?: Awareness | null;
  selfId?: string | null;
  /** The page's comments and suggestions (stable for the editor's life). */
  comments?: EditorComments | null;
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
export function PageEditor({
  doc,
  services,
  editable = true,
  onEditor,
  nested,
  awareness = null,
  selfId = null,
  comments = null,
}: PageEditorProps) {
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
      extensions: pageExtensions(doc, bridge, comments),
      editorProps: {
        attributes: { class: 'ws-prose', 'data-testid': 'page-editor', spellcheck: 'true' },
      },
    },
    [doc],
  );

  // Others' cursors: a plugin on the live editor (presence arrives after it's made).
  useEffect(() => {
    if (!editor || !awareness || editor.isDestroyed) return;
    editor.registerPlugin(cursorsPlugin(awareness, selfId));
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(cursorsPluginKey);
    };
  }, [editor, awareness, selfId]);

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

  // Equations render with the workspace's macros, and follow changes to them.
  useEffect(() => {
    if (!editor) return;
    const apply = () => setMathMacros(editor, services.mathMacros.get());
    apply();
    return services.mathMacros.subscribe(apply);
  }, [editor, services]);

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  return (
    <EditorServicesContext.Provider value={services}>
      <EditorContent editor={editor} />
      {editor && !nested && <BlockHandle editor={editor} pageId={doc.guid} />}
      {editor && <SelectionToolbar editor={editor} comments={comments} />}
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

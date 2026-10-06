import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorFragment } from '@tiptap/y-tiptap';
import {
  PAGE_CONTENT_FIELD,
  SYNCED_META,
  getPageContent,
  newId,
  setSyncedSource,
  syncedSource,
} from '@workspace/core';
import { RefreshCw } from 'lucide-react';
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { PageEditor } from '../page-editor';
import { useEditorServices, usePageRef, type EditorServices } from '../services';
import { dataAttr } from './atom';

/** Synced blocks being shown around this one (a synced block can't contain itself). */
const SyncedAncestors = createContext<readonly string[]>([]);

/** Load a doc through the services while mounted. */
function useServiceDoc(services: EditorServices, id: string | null): Y.Doc | null {
  const [loaded, setLoaded] = useState<{ id: string; doc: Y.Doc } | null>(null);
  useEffect(() => {
    if (!id) return;
    const handle = services.acquireDoc(id);
    let live = true;
    void handle.ready.then((doc) => live && setLoaded({ id, doc }));
    return () => {
      live = false;
      handle.release();
    };
  }, [services, id]);
  return loaded?.id === id ? loaded.doc : null;
}

function useSource(doc: Y.Doc | null): string | null {
  return useSyncExternalStore(
    (onChange) => {
      if (!doc) return () => {};
      const meta = doc.getMap(SYNCED_META);
      meta.observe(onChange);
      return () => meta.unobserve(onChange);
    },
    () => (doc ? syncedSource(doc) : null),
  );
}

function SyncedBlockView({ node, editor }: ReactNodeViewProps) {
  const services = useEditorServices();
  const ancestors = useContext(SyncedAncestors);
  const id = node.attrs.syncedId as string | null;
  const doc = useServiceDoc(services, id);
  const source = useSource(doc);
  const original = !source || source === services.pageId;
  const sourcePage = usePageRef(original ? null : source);
  const loops = id !== null && ancestors.includes(id);
  return (
    <NodeViewWrapper data-testid="synced-block" data-synced-id={id} className="ws-synced-block">
      <div contentEditable={false} className="ws-synced-label" data-testid="synced-label">
        <RefreshCw size={11} />
        {original ? (
          <span>Synced block</span>
        ) : (
          <button type="button" onClick={() => source && services.navigate(source)}>
            Synced from {sourcePage?.title || 'Untitled'}
          </button>
        )}
      </div>
      <div contentEditable={false}>
        {loops ? (
          <p className="text-faint">This synced block contains itself.</p>
        ) : doc ? (
          <SyncedAncestors.Provider value={[...ancestors, id!]}>
            <PageEditor doc={doc} services={services} editable={editor.isEditable} nested />
          </SyncedAncestors.Provider>
        ) : (
          <div className="h-6" aria-busy="true" />
        )}
      </div>
    </NodeViewWrapper>
  );
}

/**
 * A synced block: content kept in its own doc (`syncedId`) and shown wherever a
 * `syncedBlock` node points at it; editing any of them edits all.
 */
export const SyncedBlock = Node.create({
  name: 'syncedBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({ syncedId: dataAttr('syncedId') }),
  parseHTML: () => [{ tag: 'div[data-type="synced-block"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': 'synced-block' }),
  ],
  addNodeView: () =>
    ReactNodeViewRenderer(SyncedBlockView, {
      // The nested editor handles its own keys, clicks and selection.
      stopEvent: () => true,
      ignoreMutation: () => true,
    }),
});

/** Strip block ids so inserted copies get fresh ones. */
function withoutIds(fragment: Fragment, editor: Editor): PMNode[] {
  const strip = (json: Record<string, unknown>): Record<string, unknown> => {
    const attrs = json.attrs as Record<string, unknown> | undefined;
    const content = json.content as Record<string, unknown>[] | undefined;
    return {
      ...json,
      ...(attrs ? { attrs: { ...attrs, id: null } } : {}),
      ...(content ? { content: content.map(strip) } : {}),
    };
  };
  const nodes: PMNode[] = [];
  fragment.forEach((child) => nodes.push(editor.schema.nodeFromJSON(strip(child.toJSON()))));
  return nodes;
}

/** A doc's page content as editor nodes (fresh block ids), or an empty paragraph. */
export async function docContent(
  editor: Editor,
  services: EditorServices,
  id: string,
): Promise<PMNode[]> {
  const handle = services.acquireDoc(id);
  try {
    const doc = await handle.ready;
    const fragment = yXmlFragmentToProseMirrorFragment(getPageContent(doc), editor.schema);
    const nodes = withoutIds(fragment, editor);
    return nodes.length ? nodes : [editor.schema.nodes.paragraph!.create()];
  } finally {
    handle.release();
  }
}

/**
 * Make a synced block from `content` (empty for a new one): a new doc holding the
 * blocks, created from this page. Resolves the synced block id.
 */
export async function createSyncedDoc(
  editor: Editor,
  services: EditorServices,
  content: PMNode[] = [],
): Promise<string> {
  const id = newId();
  const handle = services.acquireDoc(id);
  try {
    const doc = await handle.ready;
    doc.transact(() => {
      setSyncedSource(doc, services.pageId);
      if (content.length) {
        const root = editor.schema.topNodeType.create(null, content);
        prosemirrorToYXmlFragment(root, doc.getXmlFragment(PAGE_CONTENT_FIELD));
      }
    });
  } finally {
    handle.release();
  }
  return id;
}

/** HTML that pastes as another copy of a synced block. */
export const syncedBlockHtml = (id: string) =>
  `<div data-type="synced-block" data-synced-id="${id}"></div>`;

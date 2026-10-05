import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useEditorServices } from '../services';
import { dataAttr } from './atom';

function DatabaseView({ node }: ReactNodeViewProps) {
  const services = useEditorServices();
  const pageId = node.attrs.pageId as string | null;
  return (
    <NodeViewWrapper data-testid="database-block" className="ws-database-block">
      <div contentEditable={false}>{pageId ? services.renderDatabase(pageId) : null}</div>
    </NodeViewWrapper>
  );
}

/**
 * An inline database: a database page (`pageId`) shown in place. The attribute is
 * named like page links' so duplicating a page tree points copies at copies.
 */
export const DatabaseBlock = Node.create({
  name: 'database',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({ pageId: dataAttr('pageId') }),
  parseHTML: () => [{ tag: 'div[data-type="database"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': 'database' }),
  ],
  addNodeView: () =>
    ReactNodeViewRenderer(DatabaseView, {
      // The table handles its own keys, clicks and selection.
      stopEvent: () => true,
      ignoreMutation: () => true,
    }),
});

function LinkedDatabaseView({ node }: ReactNodeViewProps) {
  const services = useEditorServices();
  const databaseId = node.attrs.databaseId as string | null;
  const viewSet = node.attrs.viewSet as string | null;
  return (
    <NodeViewWrapper data-testid="linked-database-block" className="ws-database-block">
      <div contentEditable={false}>
        {databaseId && viewSet ? services.renderLinkedDatabase(databaseId, viewSet) : null}
      </div>
    </NodeViewWrapper>
  );
}

/**
 * A linked view of a database elsewhere: its views (stored in the source database
 * under `viewSet`) can be changed without touching the source's own views.
 */
export const LinkedDatabaseBlock = Node.create({
  name: 'linkedDatabase',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes: () => ({ databaseId: dataAttr('databaseId'), viewSet: dataAttr('viewSet') }),
  parseHTML: () => [{ tag: 'div[data-type="linked-database"]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-type': 'linked-database' }),
  ],
  addNodeView: () =>
    ReactNodeViewRenderer(LinkedDatabaseView, {
      stopEvent: () => true,
      ignoreMutation: () => true,
    }),
});

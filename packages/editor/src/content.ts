import { getSchema, resolveExtensions, type JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import { prosemirrorToYXmlFragment } from '@tiptap/y-tiptap';
import { PAGE_CONTENT_FIELD, newId } from '@workspace/core';
import * as Y from 'yjs';
import { BLOCK_NODE_TYPES, pageExtensions } from './extensions';
import { UiBridgeHandle } from './services';

let setup: { schema: Schema; markdown: MarkdownManager } | null = null;

/** The page schema and a Markdown parser for it, built once without an editor. */
function pageSchema() {
  if (!setup) {
    const extensions = pageExtensions(new Y.Doc(), new UiBridgeHandle());
    setup = {
      schema: getSchema(extensions),
      markdown: new MarkdownManager({ extensions: resolveExtensions(extensions) }),
    };
  }
  return setup;
}

const BLOCK_TYPES = new Set<string>(BLOCK_NODE_TYPES);

/** Give every block a fresh id, as the editor would. */
function withIds(node: JSONContent): JSONContent {
  const attrs =
    node.type && BLOCK_TYPES.has(node.type) ? { ...node.attrs, id: newId() } : node.attrs;
  return {
    ...node,
    ...(attrs ? { attrs } : {}),
    ...(node.content ? { content: node.content.map(withIds) } : {}),
  };
}

/** Blocks of a page: Markdown, or editor JSON for blocks Markdown can't express. */
export type ContentPart = string | JSONContent;

/**
 * Append blocks to a page doc's content (templates and other generated pages). Markdown
 * goes through the editor's own parser, so it reads exactly like pasted Markdown.
 */
export function appendContent(doc: Y.Doc, parts: readonly ContentPart[]): void {
  const { schema, markdown } = pageSchema();
  const blocks = parts.flatMap((part) =>
    typeof part === 'string' ? (markdown.parse(part).content ?? []) : [part],
  );
  const root = PMNode.fromJSON(schema, { type: 'doc', content: blocks.map(withIds) });
  // Build into a scratch doc, then copy over: the y-tiptap helper fills a whole fragment.
  const scratch = new Y.Doc();
  prosemirrorToYXmlFragment(root, scratch.getXmlFragment(PAGE_CONTENT_FIELD));
  const fragment = doc.getXmlFragment(PAGE_CONTENT_FIELD);
  doc.transact(() => {
    fragment.insert(
      fragment.length,
      scratch
        .getXmlFragment(PAGE_CONTENT_FIELD)
        .toArray()
        .map((node) => (node as Y.XmlElement | Y.XmlText).clone()),
    );
  });
  scratch.destroy();
}

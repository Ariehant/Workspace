import { getSchema, resolveExtensions, type JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
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

/** Markdown as editor JSON blocks, with the editor's own parser (no ids yet). */
export function parseMarkdown(markdown: string): JSONContent[] {
  return pageSchema().markdown.parse(markdown).content ?? [];
}

/**
 * Turn JSON blocks into checked editor nodes: loose inline content is wrapped in
 * paragraphs, and blocks the schema can't take are left out (and counted).
 */
function toNodes(blocks: readonly JSONContent[], schema: Schema) {
  const nodes: PMNode[] = [];
  const dropped: string[] = [];
  let inline: JSONContent[] = [];
  const flush = () => {
    if (inline.length) add({ type: 'paragraph', content: inline });
    inline = [];
  };
  const add = (block: JSONContent) => {
    try {
      const node = schema.nodeFromJSON(withIds(block));
      node.check();
      nodes.push(node);
    } catch {
      dropped.push(block.type ?? 'unknown');
    }
  };
  for (const block of blocks) {
    const type = block.type ? schema.nodes[block.type] : undefined;
    if (block.type === 'text' || type?.isInline) inline.push(block);
    else {
      flush();
      add(block);
    }
  }
  flush();
  return { nodes, dropped };
}

/**
 * Append blocks to a page doc's content (templates, imports and other generated pages).
 * Markdown goes through the editor's own parser, so it reads exactly like pasted
 * Markdown. Returns the types of blocks that couldn't be added.
 */
export function appendContent(doc: Y.Doc, parts: readonly ContentPart[]): string[] {
  const { schema } = pageSchema();
  const blocks = parts.flatMap((part) => (typeof part === 'string' ? parseMarkdown(part) : [part]));
  const { nodes, dropped } = toNodes(blocks, schema);
  const root = schema.topNodeType.create(null, nodes);
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
  return dropped;
}

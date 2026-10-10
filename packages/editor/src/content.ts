import { getSchema, resolveExtensions, type JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
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

/** A page doc's content as editor JSON blocks (what the API reads). */
export function contentJson(doc: Y.Doc): JSONContent[] {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(PAGE_CONTENT_FIELD)) as JSONContent;
  return json.content ?? [];
}

/** Nodes as Yjs elements, ready to insert into a page's content (or into a block). */
function toElements(nodes: readonly PMNode[]): (Y.XmlElement | Y.XmlText)[] {
  const { schema } = pageSchema();
  const scratch = new Y.Doc();
  try {
    prosemirrorToYXmlFragment(schema.topNodeType.create(null, nodes), scratch.getXmlFragment('x'));
    return scratch
      .getXmlFragment('x')
      .toArray()
      .map((node) => (node as Y.XmlElement | Y.XmlText).clone());
  } finally {
    scratch.destroy();
  }
}

/**
 * Editor JSON blocks as page-content elements to insert anywhere (the page, a list, a
 * toggle…): checked against the schema, each with a fresh id. Also the types of blocks
 * that couldn't be made.
 */
export function contentElements(blocks: readonly JSONContent[]): {
  elements: (Y.XmlElement | Y.XmlText)[];
  dropped: string[];
} {
  const { schema } = pageSchema();
  const { nodes, dropped } = toNodes(blocks, schema);
  return { elements: toElements(nodes), dropped };
}

/** Inline content for a block of `type`, as the elements of its text (to replace them). */
export function inlineElements(
  type: string,
  inline: readonly JSONContent[],
): (Y.XmlElement | Y.XmlText)[] {
  const { schema } = pageSchema();
  const nodeType = schema.nodes[type];
  if (!nodeType) throw new Error(`No block type ${type}`);
  const node = schema.nodeFromJSON({ type, content: inline.length ? inline : undefined });
  node.check();
  const scratch = new Y.Doc();
  try {
    const fragment = scratch.getXmlFragment('x');
    prosemirrorToYXmlFragment(
      schema.topNodeType.create(null, [schema.nodes.paragraph!.create(null, node.content)]),
      fragment,
    );
    const paragraph = fragment.get(0) as Y.XmlElement;
    return paragraph.toArray().map((n) => (n as Y.XmlElement | Y.XmlText).clone());
  } finally {
    scratch.destroy();
  }
}

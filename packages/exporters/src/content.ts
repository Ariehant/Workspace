import { getPageContent } from '@workspace/core';
import * as Y from 'yjs';

/** Inline content: a run of text with its marks, or an inline node (mention, equation...). */
export type Inline =
  { text: string; marks: Marks } | { node: string; attrs: Record<string, unknown> };

/** Marks on a run of text, as stored: `{ bold: {}, link: { href } }`. */
export type Marks = Record<string, Record<string, unknown> | undefined>;

/** A block of a page, with its inline content (text blocks) and child blocks. */
export interface ContentNode {
  type: string;
  attrs: Record<string, unknown>;
  /** Text blocks (paragraphs, headings, code...): their text and inline nodes. */
  inline: Inline[];
  children: ContentNode[];
}

/** Inline nodes: they sit inside a text block's text. */
export const INLINE_NODES = new Set(['mention', 'inlineMath', 'hardBreak']);

function readInline(text: Y.XmlText): Inline[] {
  return (text.toDelta() as { insert: unknown; attributes?: Marks }[]).flatMap((op) =>
    typeof op.insert === 'string' ? [{ text: op.insert, marks: op.attributes ?? {} }] : [],
  );
}

function readNode(element: Y.XmlElement): ContentNode {
  const node: ContentNode = {
    type: element.nodeName,
    attrs: element.getAttributes() as Record<string, unknown>,
    inline: [],
    children: [],
  };
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) node.inline.push(...readInline(child));
    else if (child instanceof Y.XmlElement) {
      if (INLINE_NODES.has(child.nodeName)) {
        node.inline.push({
          node: child.nodeName,
          attrs: child.getAttributes() as Record<string, unknown>,
        });
      } else node.children.push(readNode(child));
    }
  }
  return node;
}

/** A page's content as a tree of blocks with formatted inline text. */
export function readContent(doc: Y.Doc): ContentNode[] {
  return getPageContent(doc)
    .toArray()
    .filter((node): node is Y.XmlElement => node instanceof Y.XmlElement)
    .map(readNode);
}

/** Plain text of inline content. */
export function inlineText(inline: readonly Inline[]): string {
  return inline
    .map((part) =>
      'text' in part
        ? part.text
        : part.node === 'inlineMath'
          ? String(part.attrs.latex ?? '')
          : part.node === 'hardBreak'
            ? '\n'
            : '',
    )
    .join('');
}

/** Every node in a tree, depth first. */
export function* walk(nodes: readonly ContentNode[]): Generator<ContentNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children);
  }
}

/** A boolean attribute as stored (`true` or `'true'`). */
export const flag = (value: unknown) => value === true || value === 'true';

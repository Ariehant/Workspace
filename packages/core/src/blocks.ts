import * as Y from 'yjs';
import { PAGE_CONTENT_FIELD } from './schema';

/**
 * Read-only view of one block in a page.
 *
 * Page content is stored as the ProseMirror XML tree that the editor binds to: each
 * element is a block (`paragraph`, `heading`, `bulletList`, ...), its attributes are
 * the block's props and its text children carry the inline content. This view is
 * what search indexing, export and the public API read.
 */
export interface Block {
  type: string;
  props: Record<string, unknown>;
  /** Plain text directly inside this block (not its child blocks). */
  text: string;
  children: Block[];
}

export function getPageContent(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(PAGE_CONTENT_FIELD);
}

function deltaText(text: Y.XmlText): string {
  return (text.toDelta() as { insert: unknown }[])
    .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
    .join('');
}

function readElement(element: Y.XmlElement): Block {
  const block: Block = {
    type: element.nodeName,
    props: element.getAttributes(),
    text: '',
    children: [],
  };
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) block.text += deltaText(child);
    else if (child instanceof Y.XmlElement) block.children.push(readElement(child));
  }
  return block;
}

export function readBlocks(doc: Y.Doc): Block[] {
  return getPageContent(doc)
    .toArray()
    .filter((node): node is Y.XmlElement => node instanceof Y.XmlElement)
    .map(readElement);
}

/** All text in a page, one line per block, for search indexing. */
export function pageText(doc: Y.Doc): string {
  const lines: string[] = [];
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.text) lines.push(block.text);
      walk(block.children);
    }
  };
  walk(readBlocks(doc));
  return lines.join('\n');
}

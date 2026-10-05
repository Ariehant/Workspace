import * as Y from 'yjs';
import { newId } from './ids';
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
  const props = element.getAttributes();
  // Atom blocks keep their searchable text in attributes: TeX source, captions,
  // file names and bookmark titles.
  const text = ['latex', 'caption', 'name', 'title']
    .map((key) => props[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');
  const block: Block = { type: element.nodeName, props, text, children: [] };
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

/** The first image block in a page (for card previews): its stored file or its URL. */
export function firstImage(doc: Y.Doc): { fileId?: string; src?: string } | null {
  const find = (blocks: Block[]): { fileId?: string; src?: string } | null => {
    for (const block of blocks) {
      if (block.type === 'image') {
        const { fileId, src } = block.props;
        if (typeof fileId === 'string' && fileId) return { fileId };
        if (typeof src === 'string' && src) return { src };
      }
      const inner = find(block.children);
      if (inner) return inner;
    }
    return null;
  };
  return find(readBlocks(doc));
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

export interface PageReminder {
  /** Id of the block the reminder sits in: with `date`, identifies the reminder. */
  blockId: string | null;
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Text of the block the reminder sits in, for the notification. */
  text: string;
}

/** Reminder mentions (`@remind …`) anywhere in a page. */
export function readReminders(doc: Y.Doc): PageReminder[] {
  const reminders: PageReminder[] = [];
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      for (const child of block.children) {
        if (child.type === 'mention' && isReminder(child.props)) {
          reminders.push({
            blockId: typeof block.props.id === 'string' ? block.props.id : null,
            date: String(child.props.date),
            text: block.text.replace(/\s+/g, ' ').trim(),
          });
        }
      }
      walk(block.children);
    }
  };
  walk(readBlocks(doc));
  return reminders;
}

function isReminder(props: Record<string, unknown>): boolean {
  return (props.reminder === true || props.reminder === 'true') && typeof props.date === 'string';
}

/**
 * Words in a page, as Notion counts them: runs of letters/digits, with each CJK
 * character counted as a word.
 */
export function countWords(text: string): number {
  const cjk =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length ?? 0;
  const rest = text.replace(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    ' ',
  );
  // Joiners inside a word keep it one word: don't, 3.5, ROS-2, snake_case.
  return cjk + (rest.match(/[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*/gu)?.length ?? 0);
}

/**
 * Copy a page's content into another (empty) page doc. Block ids are replaced so
 * they stay unique, and links to pages in `remap` (page links, mentions) point to
 * their copies, so a duplicated page tree links to itself rather than the original.
 */
export function copyPageContent(
  from: Y.Doc,
  to: Y.Doc,
  remap: ReadonlyMap<string, string> = new Map(),
): void {
  const fix = (node: Y.XmlElement | Y.XmlText | Y.XmlHook) => {
    if (!(node instanceof Y.XmlElement)) return;
    if (node.getAttribute('id') !== undefined) node.setAttribute('id', newId());
    const pageId = node.getAttribute('pageId') as string | undefined;
    if (pageId && remap.has(pageId)) node.setAttribute('pageId', remap.get(pageId)!);
    node.toArray().forEach(fix);
  };
  to.transact(() => {
    const clones = getPageContent(from)
      .toArray()
      .filter((node): node is Y.XmlElement | Y.XmlText => !(node instanceof Y.XmlHook))
      .map((node) => node.clone());
    getPageContent(to).insert(0, clones);
    clones.forEach(fix);
  });
}

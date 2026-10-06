import type { ChainedCommands, Editor } from '@tiptap/core';
import {
  Bookmark,
  ChevronRight,
  FileText,
  FileVideo,
  Image as ImageIcon,
  Link as LinkIcon,
  Music,
  Paperclip,
  Code2,
  Columns2,
  Columns3,
  Columns4,
  FilePlus2,
  FileSymlink,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  MessageSquareQuote,
  Minus,
  Navigation,
  Quote,
  Radical,
  Sigma,
  Table2,
  Database,
  Type,
  RefreshCw,
  MousePointerClick,
  type LucideIcon,
} from 'lucide-react';
import { insertBlockEquation, insertInlineEquation } from '../nodes/math';
import type { ToggleLevel } from '../nodes/toggle';
import { replaceCurrentBlock } from './commands';
import { newId } from '@workspace/core';
import { createSyncedDoc } from '../nodes/synced-block';

export type BlockGroup = 'basic' | 'database' | 'media' | 'advanced' | 'layout' | 'inline';

export const BLOCK_GROUP_LABELS: Record<BlockGroup, string> = {
  basic: 'Basic blocks',
  database: 'Database',
  media: 'Media',
  advanced: 'Advanced blocks',
  layout: 'Layout',
  inline: 'Inline',
};

/** Values gathered by `prepare` (e.g. a picked page) and passed to `apply`. */
export type BlockArgs = Record<string, unknown>;

/**
 * One kind of block the user can create. The slash menu, the block handle's
 * "Turn into" menu and the selection toolbar all read from `BLOCKS`, so adding a
 * block type here makes it available everywhere.
 */
export interface BlockDefinition {
  id: string;
  title: string;
  description: string;
  /** Extra words the slash menu matches, e.g. "h1" or "ul". */
  keywords: string[];
  icon: LucideIcon;
  group: BlockGroup;
  /** Markdown shortcut, shown as a hint in the slash menu. */
  shortcut?: string;
  /**
   * Ask for anything the block needs before it is inserted (a page to link to, a
   * new sub-page). Resolve `null` to cancel.
   */
  prepare?(editor: Editor): Promise<BlockArgs | null>;
  /** Turn the block(s) at the selection into this kind, or insert it there. */
  apply(chain: ChainedCommands, args: BlockArgs): ChainedCommands;
  /** Runs after `apply`, e.g. to open an editor for the new block. */
  after?(editor: Editor, args: BlockArgs): void;
  isActive(editor: Editor): boolean;
  /**
   * Offered in "Turn into" menus. Insert-only blocks (dividers, tables, page links)
   * are not, and are always placed in an empty block of their own.
   */
  convertible: boolean;
}

/** Leave a toggle title (if in one) and any lists/quotes, ready to set a new block type. */
const plain = (chain: ChainedCommands) => chain.unwrapToggleTitle().clearNodes();

const toggle = (level: ToggleLevel) => (chain: ChainedCommands) =>
  chain
    .command(({ state, commands }) =>
      state.selection.$from.parent.type.name === 'detailsSummary' ? true : commands.clearNodes(),
    )
    .setToggle(level);

const inToggleTitle = (editor: Editor, level: ToggleLevel) =>
  editor.isActive('detailsSummary', { level });

const insertOnly = { convertible: false, isActive: () => false } as const;

function cursorRect(editor: Editor): DOMRect {
  const { left, top, bottom } = editor.view.coordsAtPos(editor.state.selection.from);
  return new DOMRect(left, top, 1, bottom - top);
}

/** Insert an empty media block and open its upload / link panel. */
function mediaBlock(
  id: string,
  type: string,
  title: string,
  description: string,
  icon: LucideIcon,
  keywords: string[],
): BlockDefinition {
  return {
    id,
    title,
    description,
    keywords,
    icon,
    group: 'media',
    apply: (chain) => chain.command(replaceCurrentBlock({ type })),
    after: (editor) => focusPlaceholderBefore(editor),
    ...insertOnly,
  };
}

/** Focus the first input of the (placeholder) block just before the cursor. */
function focusPlaceholderBefore(editor: Editor) {
  const { $from } = editor.state.selection;
  const before = $from.depth >= 1 ? $from.before($from.depth) : $from.pos;
  const node = editor.state.doc.resolve(before).nodeBefore;
  if (!node) return;
  requestAnimationFrame(() => {
    const dom = editor.view.nodeDOM(before - node.nodeSize);
    if (dom instanceof HTMLElement) {
      dom.querySelector<HTMLInputElement>('input:not([type="file"])')?.focus();
    }
  });
}

const HEADING_ICONS = [Heading1, Heading2, Heading3];
const HEADING_SIZES = ['Big', 'Medium', 'Small'];

export const BLOCKS: readonly BlockDefinition[] = [
  // --- Basic blocks ---
  {
    id: 'text',
    title: 'Text',
    description: 'Just start writing with plain text.',
    keywords: ['paragraph', 'plain', 'p'],
    icon: Type,
    group: 'basic',
    apply: (chain) => plain(chain).setParagraph(),
    isActive: (editor) => editor.isActive('paragraph'),
    convertible: true,
  },
  {
    id: 'page',
    title: 'Page',
    description: 'Embed a sub-page inside this page.',
    keywords: ['subpage', 'new page', 'child'],
    icon: FilePlus2,
    group: 'basic',
    prepare: async (editor) => {
      const services = editor.storage.uiBridge.ref.current.services;
      return services ? { pageId: services.createSubpage() } : null;
    },
    apply: (chain, { pageId }) =>
      chain.command(replaceCurrentBlock({ type: 'pageLink', attrs: { pageId } })),
    after: (editor, { pageId }) =>
      editor.storage.uiBridge.ref.current.services?.navigate(pageId as string),
    ...insertOnly,
  },
  {
    id: 'todo',
    title: 'To-do list',
    description: 'Track tasks with a to-do list.',
    keywords: ['task', 'checkbox', 'check', 'todo'],
    icon: ListChecks,
    group: 'basic',
    shortcut: '[]',
    apply: (chain) => plain(chain).toggleTaskList(),
    isActive: (editor) => editor.isActive('taskList'),
    convertible: true,
  },
  ...([1, 2, 3] as const).map((level): BlockDefinition => ({
    id: `heading${level}`,
    title: `Heading ${level}`,
    description: `${HEADING_SIZES[level - 1]} section heading.`,
    keywords: [`h${level}`, 'heading', 'title'],
    icon: HEADING_ICONS[level - 1]!,
    group: 'basic',
    shortcut: `${'#'.repeat(level)} `,
    apply: (chain) => plain(chain).setHeading({ level }),
    isActive: (editor) => editor.isActive('heading', { level }),
    convertible: true,
  })),
  {
    id: 'bulletList',
    title: 'Bulleted list',
    description: 'Create a simple bulleted list.',
    keywords: ['ul', 'bullet', 'unordered', 'list'],
    icon: List,
    group: 'basic',
    shortcut: '- ',
    apply: (chain) => plain(chain).toggleBulletList(),
    isActive: (editor) => editor.isActive('bulletList'),
    convertible: true,
  },
  {
    id: 'orderedList',
    title: 'Numbered list',
    description: 'Create a list with numbering.',
    keywords: ['ol', 'ordered', 'numbered', 'list'],
    icon: ListOrdered,
    group: 'basic',
    shortcut: '1. ',
    apply: (chain) => plain(chain).toggleOrderedList(),
    isActive: (editor) => editor.isActive('orderedList'),
    convertible: true,
  },
  {
    id: 'toggle',
    title: 'Toggle list',
    description: 'Toggles can hide and show content inside.',
    keywords: ['collapse', 'expand', 'details', 'fold'],
    icon: ChevronRight,
    group: 'basic',
    shortcut: '> ',
    apply: toggle(0),
    isActive: (editor) => inToggleTitle(editor, 0),
    convertible: true,
  },
  {
    id: 'quote',
    title: 'Quote',
    description: 'Capture a quote.',
    keywords: ['blockquote', 'citation'],
    icon: Quote,
    group: 'basic',
    shortcut: '" ',
    apply: (chain) => plain(chain).toggleBlockquote(),
    isActive: (editor) => editor.isActive('blockquote'),
    convertible: true,
  },
  {
    id: 'divider',
    title: 'Divider',
    description: 'Visually divide blocks.',
    keywords: ['hr', 'rule', 'separator', 'line'],
    icon: Minus,
    group: 'basic',
    shortcut: '---',
    apply: (chain) => chain.setHorizontalRule(),
    ...insertOnly,
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'Make writing stand out.',
    keywords: ['note', 'info', 'warning', 'tip', 'highlight', 'box'],
    icon: MessageSquareQuote,
    group: 'basic',
    apply: (chain) => plain(chain).setCallout(),
    isActive: (editor) => editor.isActive('callout'),
    convertible: true,
  },
  {
    id: 'linkToPage',
    title: 'Link to page',
    description: 'Link to an existing page.',
    keywords: ['page link', 'reference', 'mention'],
    icon: FileSymlink,
    group: 'basic',
    prepare: async (editor) => {
      const page = await editor.storage.uiBridge.ref.current.pickPage?.(cursorRect(editor));
      return page ? { pageId: page.id } : null;
    },
    apply: (chain, { pageId }) =>
      chain.command(replaceCurrentBlock({ type: 'pageLink', attrs: { pageId } })),
    ...insertOnly,
  },
  {
    id: 'table',
    title: 'Table',
    description: 'Add a simple table.',
    keywords: ['grid', 'spreadsheet', 'rows', 'columns'],
    icon: Table2,
    group: 'basic',
    apply: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: false }),
    ...insertOnly,
  },
  ...([1, 2, 3] as const).map((level): BlockDefinition => ({
    id: `toggleHeading${level}`,
    title: `Toggle heading ${level}`,
    description: `Hide content inside a ${HEADING_SIZES[level - 1]!.toLowerCase()} heading.`,
    keywords: [`toggle h${level}`, 'collapse', 'heading', 'details'],
    icon: HEADING_ICONS[level - 1]!,
    group: 'basic',
    apply: toggle(level),
    isActive: (editor) => inToggleTitle(editor, level),
    convertible: true,
  })),

  // --- Databases ---
  {
    id: 'database-inline',
    title: 'Database - Inline',
    description: 'Add a table you can sort, with typed properties, inside this page.',
    keywords: ['table view', 'database', 'inline database', 'db'],
    icon: Table2,
    group: 'database',
    prepare: async (editor) => {
      const services = editor.storage.uiBridge.ref.current.services;
      return services ? { pageId: await services.createDatabase(true) } : null;
    },
    apply: (chain, { pageId }) =>
      chain.command(replaceCurrentBlock({ type: 'database', attrs: { pageId } })),
    ...insertOnly,
  },
  {
    id: 'database-linked',
    title: 'Linked view of database',
    description: 'Show a database from elsewhere, with its own views.',
    keywords: ['linked view', 'linked database', 'view', 'database', 'db'],
    icon: Database,
    group: 'database',
    prepare: async (editor) => {
      const page = await editor.storage.uiBridge.ref.current.pickPage?.(cursorRect(editor), {
        databasesOnly: true,
      });
      return page ? { databaseId: page.id, viewSet: newId() } : null;
    },
    apply: (chain, attrs) => chain.command(replaceCurrentBlock({ type: 'linkedDatabase', attrs })),
    ...insertOnly,
  },
  {
    id: 'database-page',
    title: 'Database - Full page',
    description: 'Add a database as a sub-page.',
    keywords: ['database', 'full page database', 'table', 'db'],
    icon: Database,
    group: 'database',
    prepare: async (editor) => {
      const services = editor.storage.uiBridge.ref.current.services;
      return services ? { pageId: await services.createDatabase(false) } : null;
    },
    apply: (chain, { pageId }) =>
      chain.command(replaceCurrentBlock({ type: 'pageLink', attrs: { pageId } })),
    after: (editor, { pageId }) =>
      editor.storage.uiBridge.ref.current.services?.navigate(pageId as string),
    ...insertOnly,
  },
  // --- Media ---
  mediaBlock('image', 'image', 'Image', 'Upload or embed with a link.', ImageIcon, [
    'picture',
    'photo',
    'img',
    'png',
    'jpg',
  ]),
  mediaBlock('video', 'video', 'Video', 'Upload or embed a video.', FileVideo, [
    'movie',
    'mp4',
    'clip',
  ]),
  mediaBlock('audio', 'audio', 'Audio', 'Upload or embed audio.', Music, [
    'sound',
    'mp3',
    'recording',
  ]),
  mediaBlock('file', 'file', 'File', 'Upload or link to a file.', Paperclip, [
    'attachment',
    'upload',
    'document',
  ]),
  mediaBlock('pdf', 'pdf', 'PDF', 'Embed a PDF to read it in the page.', FileText, [
    'document',
    'paper',
    'datasheet',
  ]),
  mediaBlock(
    'bookmark',
    'bookmark',
    'Web bookmark',
    'Save a link as a visual bookmark.',
    Bookmark,
    ['link', 'url', 'website', 'preview'],
  ),
  mediaBlock(
    'embed',
    'embed',
    'Embed',
    'YouTube, Vimeo, Loom, Figma, CodePen, Google Maps.',
    LinkIcon,
    ['iframe', 'youtube', 'video', 'figma', 'map'],
  ),

  // --- Advanced blocks ---
  {
    id: 'syncedBlock',
    title: 'Synced block',
    description: 'Content that stays the same everywhere you paste it.',
    keywords: ['sync', 'synced', 'mirror', 'reuse', 'transclusion'],
    icon: RefreshCw,
    group: 'advanced',
    prepare: async (editor) => {
      const services = editor.storage.uiBridge.ref.current.services;
      return services ? { syncedId: await createSyncedDoc(editor, services) } : null;
    },
    apply: (chain, attrs) => chain.command(replaceCurrentBlock({ type: 'syncedBlock', attrs })),
    ...insertOnly,
  },
  {
    id: 'button',
    title: 'Button',
    description: 'Insert blocks, add or edit database pages with a click.',
    keywords: ['button', 'template button', 'action', 'automation'],
    icon: MousePointerClick,
    group: 'advanced',
    prepare: async () => ({ buttonId: newId(), label: 'New button', color: 'default', steps: [] }),
    apply: (chain, attrs) => chain.command(replaceCurrentBlock({ type: 'button', attrs })),
    // Set it up right away, as in Notion.
    after: (editor, attrs) => {
      const services = editor.storage.uiBridge.ref.current.services;
      void services
        ?.editButton({ label: 'New button', color: 'default', steps: [] }, attrs.buttonId as string)
        .then((config) => {
          if (!config) return;
          editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'button' && node.attrs.buttonId === attrs.buttonId) {
              editor.view.dispatch(
                editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...config }),
              );
            }
          });
        });
    },
    ...insertOnly,
  },
  {
    id: 'tableOfContents',
    title: 'Table of contents',
    description: 'Show an outline of this page.',
    keywords: ['toc', 'outline', 'contents', 'headings'],
    icon: ListTree,
    group: 'advanced',
    apply: (chain) => chain.command(replaceCurrentBlock({ type: 'tableOfContents' })),
    ...insertOnly,
  },
  {
    id: 'blockEquation',
    title: 'Block equation',
    description: 'Display a standalone math equation.',
    keywords: ['math', 'latex', 'tex', 'formula', 'katex', '$$'],
    icon: Sigma,
    group: 'advanced',
    shortcut: '$$ ',
    apply: (chain) => chain,
    after: (editor) => insertBlockEquation(editor),
    ...insertOnly,
  },
  {
    id: 'code',
    title: 'Code',
    description: 'Capture a code snippet.',
    keywords: ['codeblock', 'snippet', 'pre', 'program'],
    icon: Code2,
    group: 'advanced',
    shortcut: '```',
    apply: (chain) => plain(chain).setCodeBlock(),
    isActive: (editor) => editor.isActive('codeBlock'),
    convertible: true,
  },
  {
    id: 'breadcrumb',
    title: 'Breadcrumb',
    description: 'Show where this page sits in the page tree.',
    keywords: ['path', 'navigation', 'location', 'parent'],
    icon: Navigation,
    group: 'advanced',
    apply: (chain) => chain.command(replaceCurrentBlock({ type: 'breadcrumb' })),
    ...insertOnly,
  },

  // --- Layout ---
  ...([2, 3, 4] as const).map((count): BlockDefinition => ({
    id: `columns${count}`,
    title: `${count} columns`,
    description: `Create ${count} columns of blocks.`,
    keywords: ['columns', 'layout', 'side by side', 'grid'],
    icon: [Columns2, Columns3, Columns4][count - 2]!,
    group: 'layout',
    apply: (chain) => chain.insertColumns(count),
    ...insertOnly,
  })),

  // --- Inline ---
  {
    id: 'inlineEquation',
    title: 'Inline equation',
    description: 'Insert math within a line of text.',
    keywords: ['math', 'latex', 'tex', 'formula', 'katex', '$'],
    icon: Radical,
    group: 'inline',
    shortcut: '$$x$$',
    apply: (chain) => chain,
    after: (editor) => insertInlineEquation(editor),
    ...insertOnly,
  },
];

/** Blocks the "Turn into" menus offer. */
export const CONVERTIBLE_BLOCKS = BLOCKS.filter((block) => block.convertible);

export function getBlock(id: string): BlockDefinition | undefined {
  return BLOCKS.find((block) => block.id === id);
}

/** The block kind at the selection, for "Turn into" labels. */
export function activeBlock(editor: Editor): BlockDefinition | undefined {
  // Most specific first: a paragraph inside a callout reads as "Callout".
  const order = ['callout', 'todo', 'bulletList', 'orderedList', 'quote', 'code'];
  const specific = order.map(getBlock).find((b) => b?.isActive(editor));
  return specific ?? CONVERTIBLE_BLOCKS.find((block) => block.isActive(editor));
}

/**
 * Rank blocks against a slash-menu query. Prefix matches on the title come first,
 * then prefix matches on any word or keyword, then substring and subsequence matches.
 */
export function searchBlocks(query: string, blocks: readonly BlockDefinition[] = BLOCKS) {
  const q = query.trim().toLowerCase();
  if (!q) return [...blocks];

  const score = (block: BlockDefinition): number => {
    const title = block.title.toLowerCase();
    const words = [...title.split(/\s+/), ...block.keywords.map((k) => k.toLowerCase())];
    if (title.startsWith(q)) return 4;
    if (words.some((w) => w.startsWith(q))) return 3;
    if (title.includes(q) || words.some((w) => w.includes(q))) return 2;
    let i = 0;
    for (const ch of title) if (ch === q[i]) i++;
    return i === q.length ? 1 : 0;
  };

  return blocks
    .map((block, index) => ({ block, index, score: score(block) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.block);
}

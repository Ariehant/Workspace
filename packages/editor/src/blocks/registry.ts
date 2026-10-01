import type { ChainedCommands, Editor } from '@tiptap/core';
import {
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  Quote,
  Type,
  type LucideIcon,
} from 'lucide-react';

export type BlockGroup = 'basic' | 'media' | 'advanced';

export const BLOCK_GROUP_LABELS: Record<BlockGroup, string> = {
  basic: 'Basic blocks',
  media: 'Media',
  advanced: 'Advanced blocks',
};

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
  /** Turn the block(s) at the selection into this kind. */
  apply(chain: ChainedCommands): ChainedCommands;
  isActive(editor: Editor): boolean;
  /** Offered in "Turn into" menus (insert-only blocks like dividers are not). */
  convertible: boolean;
}

const inList = (editor: Editor) => editor.isActive('bulletList') || editor.isActive('orderedList');

export const BLOCKS: readonly BlockDefinition[] = [
  {
    id: 'text',
    title: 'Text',
    description: 'Just start writing with plain text.',
    keywords: ['paragraph', 'plain', 'p'],
    icon: Type,
    group: 'basic',
    apply: (chain) => chain.clearNodes().setParagraph(),
    isActive: (editor) =>
      editor.isActive('paragraph') && !inList(editor) && !editor.isActive('blockquote'),
    convertible: true,
  },
  ...([1, 2, 3] as const).map((level): BlockDefinition => ({
    id: `heading${level}`,
    title: `Heading ${level}`,
    description: ['Big section heading.', 'Medium section heading.', 'Small section heading.'][
      level - 1
    ]!,
    keywords: [`h${level}`, 'heading', 'title'],
    icon: [Heading1, Heading2, Heading3][level - 1]!,
    group: 'basic',
    shortcut: `${'#'.repeat(level)} `,
    apply: (chain) => chain.clearNodes().setHeading({ level }),
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
    apply: (chain) => chain.clearNodes().toggleBulletList(),
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
    apply: (chain) => chain.clearNodes().toggleOrderedList(),
    isActive: (editor) => editor.isActive('orderedList'),
    convertible: true,
  },
  {
    id: 'quote',
    title: 'Quote',
    description: 'Capture a quote.',
    keywords: ['blockquote', 'citation'],
    icon: Quote,
    group: 'basic',
    shortcut: '> ',
    apply: (chain) => chain.clearNodes().toggleBlockquote(),
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
    isActive: () => false,
    convertible: false,
  },
  {
    id: 'code',
    title: 'Code',
    description: 'Capture a code snippet.',
    keywords: ['codeblock', 'snippet', 'pre', 'program'],
    icon: Code2,
    group: 'advanced',
    shortcut: '```',
    apply: (chain) => chain.clearNodes().setCodeBlock(),
    isActive: (editor) => editor.isActive('codeBlock'),
    convertible: true,
  },
];

export function getBlock(id: string): BlockDefinition | undefined {
  return BLOCKS.find((block) => block.id === id);
}

/** The block kind at the selection, for "Turn into" labels. */
export function activeBlock(editor: Editor): BlockDefinition | undefined {
  // Check more specific kinds (lists, quotes) before plain text.
  return [...BLOCKS].reverse().find((block) => block.convertible && block.isActive(editor));
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

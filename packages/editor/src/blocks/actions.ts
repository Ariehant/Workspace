import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { parseDate, toIsoDate } from '@workspace/core';
import {
  AtSign,
  Bell,
  CalendarDays,
  Copy,
  FileSymlink,
  MessageSquare,
  Palette,
  Repeat2,
  Smile,
  Trash2,
} from 'lucide-react';
import { COLOR_CHOICES } from '../color-menu';
import { anchorFor, type EditorComments } from '../comments';
import type { ColorValue } from '../nodes/colors';
import { openEmojiMenu } from '../nodes/emoji';
import { deleteBlockAt, duplicateBlockAt, typeTrigger } from './commands';
import type { BlockDefinition } from './registry';

/**
 * The block the cursor is in, as the block handle sees it: a list item rather than its
 * first paragraph, a toggle rather than its title.
 */
export function blockAtCursor(state: EditorState): { node: PMNode; pos: number } | null {
  const { $from } = state.selection;
  let depth = $from.depth;
  if (depth < 1) return null;
  const parent = depth > 1 ? $from.node(depth - 1) : null;
  if ($from.parent.type.name === 'detailsSummary') depth -= 1;
  else if (
    parent &&
    ['listItem', 'taskItem'].includes(parent.type.name) &&
    $from.index(depth - 1) === 0
  ) {
    depth -= 1;
  }
  return { node: $from.node(depth), pos: $from.before(depth) };
}

/** Colour the nearest block at the cursor that takes a colour. */
export function colorAtCursor(editor: Editor, value: ColorValue | null) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    if (!('color' in node.attrs)) continue;
    // Callouts keep a background ("Default background" is their standard gray).
    const next = node.type.name === 'callout' && value === null ? 'gray_background' : value;
    editor.chain().focus().setBlockColor($from.before(depth), next).run();
    return;
  }
}

const action = (
  block: Omit<BlockDefinition, 'action' | 'searchOnly' | 'convertible' | 'isActive' | 'apply'> & {
    run(editor: Editor): void;
  },
): BlockDefinition => {
  const { run, ...rest } = block;
  return {
    ...rest,
    action: true,
    searchOnly: true,
    convertible: false,
    isActive: () => false,
    apply: (chain) => chain,
    after: (editor) => run(editor),
  };
};

const commentsHost = (editor: Editor): EditorComments | null =>
  (
    editor.extensionManager.extensions.find((e) => e.name === 'comments')?.options as
      { host: EditorComments | null } | undefined
  )?.host ?? null;

/**
 * Commands the slash menu finds when searched for (`/red`, `/turn into h1`, `/duplicate`,
 * `/comment`, `/today`…), acting on the block the cursor is in, as in Notion. They stay out
 * of the unfiltered menu. `query` is what's typed after the `/`.
 */
export function actionBlocks(
  editor: Editor,
  query: string,
  convertible: readonly BlockDefinition[],
): BlockDefinition[] {
  const blocks: BlockDefinition[] = [];
  const host = commentsHost(editor);
  // Comments are on text: the block needs some besides the `/query`.
  const text = editor.state.selection.$from.parent.textContent;
  if (host && text.length > query.length + 1) {
    blocks.push(
      action({
        id: 'action:comment',
        title: 'Comment',
        description: 'Comment on this block.',
        keywords: ['comment', 'discuss', 'note', 'feedback'],
        icon: MessageSquare,
        group: 'actions',
        run: (ed) => {
          const { $from } = ed.state.selection;
          const anchor = anchorFor(ed.state, $from.start(), $from.end());
          if (!anchor) return;
          ed.commands.setTextSelection($from.end());
          host.comment(anchor);
        },
      }),
    );
  }
  blocks.push(
    action({
      id: 'action:duplicate',
      title: 'Duplicate',
      description: 'Make a copy of this block below it.',
      keywords: ['copy', 'clone', 'duplicate'],
      icon: Copy,
      group: 'actions',
      run: (ed) => {
        const target = blockAtCursor(ed.state);
        if (target) duplicateBlockAt(ed, target.pos, target.node);
      },
    }),
    action({
      id: 'action:delete',
      title: 'Delete',
      description: 'Delete this block.',
      keywords: ['remove', 'delete', 'trash'],
      icon: Trash2,
      group: 'actions',
      run: (ed) => {
        const target = blockAtCursor(ed.state);
        if (target) deleteBlockAt(ed, target.pos, target.node);
      },
    }),
    action({
      id: 'action:today',
      title: 'Today',
      description: 'Insert today’s date (click it to change it).',
      keywords: ['date', 'now', 'today', 'time'],
      icon: CalendarDays,
      group: 'actions',
      run: (ed) => {
        const today = toIsoDate(parseDate('today')!);
        ed.chain()
          .focus()
          .insertContent([
            { type: 'mention', attrs: { kind: 'date', date: today, reminder: false } },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
    }),
    action({
      id: 'action:reminder',
      title: 'Reminder',
      description: 'Remind yourself on a date.',
      keywords: ['remind', 'date', 'due', 'alarm'],
      icon: Bell,
      group: 'actions',
      run: (ed) => typeTrigger(ed, '@remind '),
    }),
    action({
      id: 'action:mentionPerson',
      title: 'Mention a person',
      description: 'Notify someone in this workspace.',
      keywords: ['mention', 'person', 'people', 'user', '@'],
      icon: AtSign,
      group: 'actions',
      run: (ed) => typeTrigger(ed, '@'),
    }),
    action({
      id: 'action:mentionPage',
      title: 'Mention a page',
      description: 'Link to a page in the text.',
      keywords: ['mention', 'page', 'link', '@'],
      icon: FileSymlink,
      group: 'actions',
      run: (ed) => typeTrigger(ed, '@'),
    }),
    action({
      id: 'action:emoji',
      title: 'Emoji',
      description: 'Search for an emoji to insert.',
      keywords: ['emoji', 'emoticon', 'smiley', 'icon'],
      icon: Smile,
      group: 'actions',
      run: (ed) => openEmojiMenu(ed),
    }),
  );
  for (const { choices } of COLOR_CHOICES) {
    for (const choice of choices) {
      blocks.push(
        action({
          id: `color:${choice.value ?? (choice.label.endsWith('background') ? 'default_background' : 'default')}`,
          title: choice.label,
          description: choice.label.endsWith('background')
            ? 'Colour this block’s background.'
            : 'Colour this block’s text.',
          keywords: ['color', 'colour'],
          icon: Palette,
          group: 'color',
          run: (ed) => colorAtCursor(ed, choice.value),
        }),
      );
    }
  }
  for (const block of convertible) {
    blocks.push(
      action({
        id: `turnInto:${block.id}`,
        title: `Turn into ${block.title.toLowerCase()}`,
        description: `Change this block to ${block.title.toLowerCase()}.`,
        keywords: ['turn', 'convert', 'turn into', ...block.keywords.map((k) => `turn${k}`)],
        icon: Repeat2,
        group: 'turnInto',
        run: (ed) => block.apply(ed.chain().focus(), {}).run(),
      }),
    );
  }
  return blocks;
}

import { Extension } from '@tiptap/core';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import NodeRange, { isNodeRangeSelection } from '@tiptap/extension-node-range';
import UniqueID from '@tiptap/extension-unique-id';
import { Placeholder } from '@tiptap/extensions';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { search } from 'prosemirror-search';
import StarterKit from '@tiptap/starter-kit';
import { PAGE_CONTENT_FIELD } from '@workspace/core';
import type * as Y from 'yjs';
import { Callout } from './nodes/callout';
import { CodeBlock } from './nodes/code-block';
import { lineStarts } from './nodes/code-lines';
import { Column, ColumnList } from './nodes/columns';
import { BlockColor, TextColor } from './nodes/colors';
import { EmojiSuggest } from './nodes/emoji';
import { MarkdownClipboard } from './nodes/markdown';
import { mathExtensions } from './nodes/math';
import { Mention } from './nodes/mention';
import { MediaBlocks } from './nodes/media';
import { PasteAndDrop } from './nodes/paste-drop';
import { Breadcrumb, PageLink, TableOfContents } from './nodes/page-blocks';
import { DatabaseBlock, LinkedDatabaseBlock } from './nodes/database';
import { SyncedBlock } from './nodes/synced-block';
import { ButtonBlock } from './nodes/button';
import { Quote } from './nodes/quote';
import { Table } from './nodes/table';
import { TodoItem, TodoList } from './nodes/todo';
import { ToggleExtensions } from './nodes/toggle';
import { uiBridgeExtension, type UiBridgeHandle } from './services';
import { SlashCommand } from './slash-menu/slash-command';

/** Node types that are blocks and get a stable `id` attribute. */
export const BLOCK_NODE_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'details',
  'callout',
  'blockMath',
  'table',
  'columnList',
  'column',
  'pageLink',
  'database',
  'linkedDatabase',
  'syncedBlock',
  'button',
  'breadcrumb',
  'tableOfContents',
  'image',
  'video',
  'audio',
  'pdf',
  'file',
  'bookmark',
  'embed',
];

/** Highlights for find-in-page; Mod-F opens the find bar. */
const FindInPage = Extension.create({
  name: 'findInPage',
  addProseMirrorPlugins: () => [search()],
  addKeyboardShortcuts() {
    return {
      'Mod-f': () => {
        this.editor.storage.uiBridge.ref.current.openFind?.();
        return true;
      },
    };
  },
});

/**
 * Ctrl/Cmd+click opens a link (plain clicks just place the cursor while editing; in a
 * read-only page any click opens it). `workspace://` links open in the app via the host.
 */
const OpenLinkOnModClick = Extension.create({
  name: 'openLinkOnModClick',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClick(view, _pos, event) {
            if (!(event.ctrlKey || event.metaKey) && view.editable) return false;
            const link = (event.target as HTMLElement | null)?.closest('a[href]');
            if (!link) return false;
            window.open(link.getAttribute('href')!, '_blank', 'noopener');
            return true;
          },
        },
      }),
    ];
  },
});

/**
 * Placeholder text by node type. (Text that depends on the parent, such as "List"
 * inside a list item, is set in editor.css: decorations are built for the new
 * document before `editor.state` updates, so positions can't be resolved here.)
 */
function placeholderFor({ node }: { node: PMNode }): string {
  if (node.type.name === 'heading') return `Heading ${node.attrs.level as number}`;
  if (node.type.name === 'detailsSummary') {
    return node.attrs.level ? `Toggle heading ${node.attrs.level as number}` : 'Toggle';
  }
  return "Write, or press '/' for commands…";
}

/** Position a line above or below `$head` in a code block (same column), or null. */
function codeLineHead($head: ResolvedPos, direction: 'up' | 'down'): number | null {
  if ($head.parent.type.name !== 'codeBlock') return null;
  const text = $head.parent.textContent;
  const starts = lineStarts(text);
  const offset = $head.parentOffset;
  let line = starts.length - 1;
  while (starts[line]! > offset) line--;
  const target = line + (direction === 'up' ? -1 : 1);
  if (target < 0 || target >= starts.length) return null;
  const end = target + 1 < starts.length ? starts[target + 1]! - 1 : text.length;
  const column = offset - starts[line]!;
  return $head.start() + Math.min(starts[target]! + column, end);
}

/**
 * Shift+↑/↓ selects whole blocks, but only from a block's first or last line: inside a
 * multi-line block (a code block, a wrapped paragraph) it extends the text selection.
 */
const BlockRange = NodeRange.extend({
  addKeyboardShortcuts() {
    const parent = this.parent?.() ?? {};
    const textFirst =
      (direction: 'up' | 'down', key: 'Shift-ArrowUp' | 'Shift-ArrowDown') =>
      (props: Parameters<NonNullable<(typeof parent)[string]>>[0]) => {
        const { state, view } = props.editor;
        if (!isNodeRangeSelection(state.selection)) {
          // In code, move the selection's head a line up or down, keeping the column.
          const head = codeLineHead(state.selection.$head, direction);
          if (head !== null) {
            const { anchor } = state.selection;
            view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)));
            return true;
          }
          if (!view.endOfTextblock(direction)) return false;
        }
        return parent[key]?.(props) ?? false;
      };
    return {
      ...parent,
      'Shift-ArrowUp': textFirst('up', 'Shift-ArrowUp'),
      'Shift-ArrowDown': textFirst('down', 'Shift-ArrowDown'),
    };
  },
});

export function pageExtensions(doc: Y.Doc, bridge: UiBridgeHandle) {
  return [
    StarterKit.configure({
      undoRedo: false, // Yjs provides per-user undo through Collaboration.
      blockquote: false, // replaced by Quote (Notion's `"` shortcut)
      codeBlock: false, // replaced by CodeBlock (syntax highlighting)
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
      dropcursor: { color: 'var(--ws-accent)', width: 3 },
    }),
    Quote,
    TodoList,
    TodoItem,
    ...ToggleExtensions,
    Callout,
    CodeBlock,
    ...mathExtensions(bridge),
    Table,
    ColumnList,
    Column,
    PageLink,
    DatabaseBlock,
    LinkedDatabaseBlock,
    SyncedBlock,
    ButtonBlock,
    Breadcrumb,
    TableOfContents,
    ...MediaBlocks,
    PasteAndDrop,
    MarkdownClipboard,
    Mention,
    EmojiSuggest,
    TextColor,
    BlockColor,
    FindInPage,
    Placeholder.configure({ placeholder: placeholderFor, includeChildren: true }),
    UniqueID.configure({
      types: BLOCK_NODE_TYPES,
      // Remote changes already carry ids; only assign ids to local edits.
      filterTransaction: (transaction) => !isChangeOrigin(transaction),
    }),
    Collaboration.configure({ document: doc, field: PAGE_CONTENT_FIELD }),
    BlockRange,
    SlashCommand,
    OpenLinkOnModClick,
    uiBridgeExtension(bridge),
  ];
}

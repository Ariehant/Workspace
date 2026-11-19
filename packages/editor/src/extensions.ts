import { Extension, combineTransactionSteps } from '@tiptap/core';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import NodeRange, { isNodeRangeSelection } from '@tiptap/extension-node-range';
import UniqueID from '@tiptap/extension-unique-id';
import { Placeholder } from '@tiptap/extensions';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { Plugin, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { search } from 'prosemirror-search';
import StarterKit from '@tiptap/starter-kit';
import { PAGE_CONTENT_FIELD } from '@workspace/core';
import type * as Y from 'yjs';
import { Comments, type EditorComments } from './comments';
import { Callout } from './nodes/callout';
import { CodeBlock } from './nodes/code-block';
import { lineStarts } from './nodes/code-lines';
import { Column, ColumnList } from './nodes/columns';
import { BlockColor, TextColor } from './nodes/colors';
import { CustomEmoji } from './nodes/custom-emoji';
import { EmojiSuggest } from './nodes/emoji';
import { MarkdownClipboard } from './nodes/markdown';
import { mathExtensions } from './nodes/math';
import { Mention } from './nodes/mention';
import { MediaBlocks } from './nodes/media';
import { LinkedFileBlock } from './nodes/linked-file';
import { DriveFileBlock } from './nodes/drive-file';
import { PasteAndDrop } from './nodes/paste-drop';
import { Breadcrumb, PageLink, TableOfContents } from './nodes/page-blocks';
import { DatabaseBlock, LinkedDatabaseBlock } from './nodes/database';
import { SyncedBlock } from './nodes/synced-block';
import { ButtonBlock } from './nodes/button';
import { Quote } from './nodes/quote';
import { Table } from './nodes/table';
import { Tab, Tabs } from './nodes/tabs';
import { TodoItem, TodoList } from './nodes/todo';
import { ToggleExtensions } from './nodes/toggle';
import { uiBridgeExtension, type UiBridgeHandle } from './services';
import { BlockShortcuts } from './shortcuts';
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
  'tabs',
  'tab',
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
/**
 * Keys act on the cursor the person sees. The browser moves the caret itself for some keys
 * (End, Ctrl+End, Shift+Home…), and ProseMirror learns of it from a `selectionchange`
 * event that comes later. A key pressed before that event (typing fast, or on a busy
 * machine, where input runs first) would act on the old cursor: Enter splitting the line
 * the caret just left. So the selection is read from the page before any key is handled.
 *
 * The same goes for a change that arrives in that moment from elsewhere (a decoration redrawn,
 * a timer's update): ProseMirror would write its old selection back into the page, and the
 * move (Shift+Home's selection, say) would be lost. So such a change reads it first too.
 */
/** What these helpers use of ProseMirror's (internal) DOM observer. */
interface DomObserver {
  currentSelection: { eq(range: object): boolean };
  pendingRecords(): readonly unknown[];
  forceFlush(): void;
  onSelectionChange(): void;
}

/**
 * `tr`, made without a selection the page holds that ProseMirror hasn't read yet: the page's is
 * read first, and the transaction keeps it (mapped through its changes). Transactions that set a
 * selection themselves, and moments with unread typing (read together with it), pass unchanged.
 */
function withUnreadSelection(view: EditorView, tr: Transaction): Transaction {
  // Only a key's move: other changes of the page's selection (the browser's caret as the editor
  // takes focus back from a field, before ProseMirror puts its own back) aren't the person's.
  if (!keyMoving.has(view)) return tr;
  if (tr.selectionSet || view.isDestroyed || view.composing || !view.hasFocus()) return tr;
  const observer = (view as unknown as { domObserver: DomObserver }).domObserver;
  const dom = (view.root as Document).getSelection?.() ?? document.getSelection();
  if (!dom?.focusNode || observer.currentSelection.eq(dom)) return tr;
  if (observer.pendingRecords().length > 0) return tr;
  const before = view.state;
  observer.forceFlush();
  observer.onSelectionChange();
  const read = view.state;
  // Read only a selection (the document is the one `tr` starts from), and something changed.
  if (read.doc !== tr.before || read.selection.eq(before.selection)) return tr;
  return tr.setSelection(read.selection.map(tr.doc, tr.mapping));
}

/** Views where a key was pressed whose move of the selection ProseMirror hasn't read yet. */
const keyMoving = new WeakSet<EditorView>();

/** Views reading an unread selection right now (the read dispatches, and updates the view). */
const reading = new WeakSet<EditorView>();

/**
 * Read a key's move of the selection that ProseMirror hasn't read yet, before an update of
 * the view that isn't a transaction (a plugin registered or removed, props set): such an
 * update redraws the page with ProseMirror's selection, writing the old caret back over the
 * move. True if it read one.
 */
function readUnreadSelection(view: EditorView): boolean {
  if (!keyMoving.has(view) || reading.has(view)) return false;
  if (view.isDestroyed || view.composing || !view.hasFocus()) return false;
  const observer = (view as unknown as { domObserver: DomObserver }).domObserver;
  const dom = (view.root as Document).getSelection?.() ?? document.getSelection();
  if (!dom?.focusNode || observer.currentSelection.eq(dom)) return false;
  // Unread typing too: left to ProseMirror (reading it here would change the document).
  if (observer.pendingRecords().length > 0) return false;
  reading.add(view);
  try {
    observer.forceFlush();
    observer.onSelectionChange();
  } finally {
    reading.delete(view);
  }
  return true;
}

/**
 * Have `updateState` and `setProps` read an unread key move first. A new state made from the
 * old one (the same document and selection, other plugins) keeps the move.
 */
function readBeforeViewUpdates(view: EditorView): void {
  const updateState = view.updateState.bind(view);
  const setProps = view.setProps.bind(view);
  view.updateState = (state) => {
    const before = view.state;
    const keepsSelection = state.doc === before.doc && state.selection.eq(before.selection);
    if (!keepsSelection || !readUnreadSelection(view)) return updateState(state);
    const read = view.state.selection;
    if (view.state.doc !== state.doc || read.eq(state.selection)) return updateState(state);
    updateState(state.apply(state.tr.setSelection(read)));
  };
  view.setProps = (props) => {
    readUnreadSelection(view);
    setProps(props);
  };
}

const KeysUseCurrentSelection = Extension.create({
  name: 'keysUseCurrentSelection',
  // Before every keymap.
  priority: 10_000,
  dispatchTransaction({ transaction, next }) {
    // Before the editor is mounted there's no page to read (and `view` throws).
    if (!this.editor.isInitialized || this.editor.isDestroyed) return next(transaction);
    next(withUnreadSelection(this.editor.view, transaction));
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            // Not while composing: the IME owns the selection then.
            if (view.composing || event.isComposing || event.keyCode === 229) return false;
            // ProseMirror's own handler for that event (a no-op if they already match).
            (
              view as unknown as { domObserver: { onSelectionChange(): void } }
            ).domObserver.onSelectionChange();
            // The browser may now move the selection itself, read on the next selectionchange.
            keyMoving.add(view);
            return false;
          },
        },
        view(view) {
          readBeforeViewUpdates(view);
          // Registered after ProseMirror's own listener: by now it has read the move.
          const read = () => keyMoving.delete(view);
          const doc = view.dom.ownerDocument;
          doc.addEventListener('selectionchange', read);
          return { destroy: () => doc.removeEventListener('selectionchange', read) };
        },
      }),
    ];
  },
});

/**
 * Enter in an empty block keeps the block's id where it was. UniqueID moves an id to the second
 * half of a split when the first is empty, so that Enter at the start of a line leaves the
 * line's id with its text. When the split block was empty, though, both halves are, and the
 * id would go to the new block, typed into next. Two people pressing Enter at the same empty
 * line (at the end of a page, say) would then each make a new block with that same id, and
 * after merging the page has two blocks with one id. So for an empty block, the id goes back.
 */
const KeepIdOnEmptySplit = Extension.create({
  name: 'keepIdOnEmptySplit',
  addProseMirrorPlugins() {
    const types = new Set<string>(BLOCK_NODE_TYPES);
    return [
      new Plugin({
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((t) => t.docChanged)) return null;
          if (transactions.some((t) => isChangeOrigin(t))) return null;
          const before = new Map<string, number>();
          oldState.doc.descendants((node, pos) => {
            const id = node.attrs.id as unknown;
            if (types.has(node.type.name) && typeof id === 'string') before.set(id, pos);
          });
          const { mapping } = combineTransactionSteps(oldState.doc, [...transactions]);
          const swaps: { from: number; to: number; id: string; other: string }[] = [];
          newState.doc.descendants((node, pos) => {
            const id = node.attrs.id as unknown;
            if (!types.has(node.type.name) || typeof id !== 'string' || node.content.size) return;
            const was = before.get(id);
            if (was === undefined) return;
            const at = mapping.map(was, -1);
            if (at === pos) return;
            const first = newState.doc.nodeAt(at);
            const other = first?.attrs.id as unknown;
            // The block where this one was: empty too, of the same type, with a new id.
            if (
              first &&
              first.type === node.type &&
              first.content.size === 0 &&
              typeof other === 'string' &&
              !before.has(other) &&
              at + first.nodeSize === pos
            ) {
              swaps.push({ from: at, to: pos, id, other });
            }
          });
          if (!swaps.length) return null;
          const tr = newState.tr;
          for (const { from, to, id, other } of swaps) {
            tr.setNodeAttribute(from, 'id', id);
            tr.setNodeAttribute(to, 'id', other);
          }
          return tr;
        },
      }),
    ];
  },
});

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

export function pageExtensions(
  doc: Y.Doc,
  bridge: UiBridgeHandle,
  comments: EditorComments | null = null,
) {
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
    Tabs,
    Tab,
    PageLink,
    DatabaseBlock,
    LinkedDatabaseBlock,
    SyncedBlock,
    ButtonBlock,
    Breadcrumb,
    TableOfContents,
    ...MediaBlocks,
    LinkedFileBlock,
    DriveFileBlock,
    PasteAndDrop,
    MarkdownClipboard,
    Mention,
    CustomEmoji,
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
    KeepIdOnEmptySplit, // after UniqueID
    Collaboration.configure({ document: doc, field: PAGE_CONTENT_FIELD }),
    Comments.configure({ host: comments }),
    BlockRange,
    BlockShortcuts,
    SlashCommand,
    OpenLinkOnModClick,
    uiBridgeExtension(bridge),
    KeysUseCurrentSelection,
  ];
}

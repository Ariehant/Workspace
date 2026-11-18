/**
 * Notion's block shortcuts: move, duplicate and turn blocks into others from the keyboard,
 * re-apply the last colour, check a to-do or open a toggle.
 */
import { Extension, type Editor, type JSONContent } from '@tiptap/core';
import { isNodeRangeSelection } from '@tiptap/extension-node-range';
import type { EditorState } from '@tiptap/pm/state';
import { blockAtCursor, colorAtCursor } from './blocks/actions';
import { insertBlockFromSlash, withoutBlockIds } from './blocks/commands';
import { getBlock } from './blocks/registry';
import { COLOR_PICKED, type ColorValue } from './nodes/colors';
import { insertInlineEquation } from './nodes/math';

/** The blocks a shortcut acts on: the selected ones, or the one with the cursor. */
function selectedBlocks(state: EditorState): { from: number; to: number } | null {
  const { selection } = state;
  if (isNodeRangeSelection(selection)) return { from: selection.from, to: selection.to };
  const block = blockAtCursor(state);
  return block ? { from: block.pos, to: block.pos + block.node.nodeSize } : null;
}

/** Swap the blocks with the one above (`-1`) or below (`1`) them, in the same parent. */
export function moveBlocks(editor: Editor, direction: -1 | 1): boolean {
  const range = selectedBlocks(editor.state);
  if (!range) return false;
  const { doc } = editor.state;
  const $from = doc.resolve(range.from);
  const parent = $from.parent;
  const first = $from.index();
  const last = doc.resolve(range.to).index($from.depth) - 1;
  const neighbour = direction < 0 ? first - 1 : last + 1;
  // At the top or bottom of its parent it stays (the key is still taken).
  if (neighbour < 0 || neighbour >= parent.childCount) return true;
  const other = parent.child(neighbour);
  const tr = editor.state.tr;
  if (direction < 0) {
    const start = range.from - other.nodeSize;
    tr.insert(range.to, other).delete(start, range.from);
  } else {
    tr.delete(range.to, range.to + other.nodeSize).insert(range.from, other);
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Ctrl+Alt+0…9, as in Notion. */
const TURN_INTO: Record<string, string> = {
  0: 'text',
  1: 'heading1',
  2: 'heading2',
  3: 'heading3',
  4: 'todo',
  5: 'bulletList',
  6: 'orderedList',
  7: 'toggle',
  8: 'code',
};

export interface BlockShortcutsStorage {
  /** The colour picked last (Ctrl+Shift+H applies it again). */
  lastColor: ColorValue | null;
}

declare module '@tiptap/core' {
  interface Storage {
    blockShortcuts: BlockShortcutsStorage;
  }
}

export const BlockShortcuts = Extension.create<object, BlockShortcutsStorage>({
  name: 'blockShortcuts',
  // Before the defaults (Ctrl+Enter is also a line break, Ctrl+Alt+1 a heading).
  priority: 1000,
  addStorage: () => ({ lastColor: null }),

  onTransaction({ transaction }) {
    const color = transaction.getMeta(COLOR_PICKED) as ColorValue | null | undefined;
    if (color) this.storage.lastColor = color;
  },

  addKeyboardShortcuts() {
    const editor = this.editor;
    const turnInto = (id: string) => () => {
      const block = getBlock(id);
      return block ? block.apply(editor.chain().focus(), {}).run() : false;
    };
    const shortcuts: Record<string, () => boolean> = {
      'Mod-Shift-ArrowUp': () => moveBlocks(editor, -1),
      'Mod-Shift-ArrowDown': () => moveBlocks(editor, 1),
      'Mod-d': () => {
        const range = selectedBlocks(editor.state);
        if (!range) return false;
        // Copies get ids of their own, as with the block menu's Duplicate.
        const copies: JSONContent[] = [];
        editor.state.doc.slice(range.from, range.to).content.forEach((node) => {
          copies.push(withoutBlockIds(node.toJSON() as JSONContent));
        });
        editor.chain().focus().insertContentAt(range.to, copies).run();
        return true;
      },
      ...Object.fromEntries(
        Object.entries(TURN_INTO).map(([key, id]) => [`Mod-Alt-${key}`, turnInto(id)]),
      ),
      // A new sub-page, here.
      'Mod-Alt-9': () => {
        const page = getBlock('page');
        if (!page) return false;
        const { from } = editor.state.selection;
        void insertBlockFromSlash(editor, { from, to: from }, page);
        return true;
      },
      'Mod-Shift-h': () => {
        const color = this.storage.lastColor;
        if (!color) return false;
        if (editor.state.selection.empty) colorAtCursor(editor, color);
        else editor.chain().focus().setTextColor(color).run();
        return true;
      },
      'Mod-Shift-e': () => {
        insertInlineEquation(editor);
        return true;
      },
      // Check a to-do, or open or close a toggle.
      'Mod-Enter': () => {
        const { $from } = editor.state.selection;
        for (let depth = $from.depth; depth >= 1; depth--) {
          const node = $from.node(depth);
          if (node.type.name === 'taskItem') {
            const pos = $from.before(depth);
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                checked: !node.attrs.checked,
              }),
            );
            return true;
          }
          if (node.type.name === 'details') {
            const dom = editor.view.nodeDOM($from.before(depth));
            if (dom instanceof HTMLElement) {
              dom.querySelector<HTMLButtonElement>(':scope > button')?.click();
            }
            return true;
          }
        }
        return false;
      },
    };
    // Each acts on the selection as it is on the page: a click just before the key can
    // reach ProseMirror after it.
    return Object.fromEntries(
      Object.entries(shortcuts).map(([key, run]) => [
        key,
        () => {
          (editor.view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
          return run();
        },
      ]),
    );
  },
});

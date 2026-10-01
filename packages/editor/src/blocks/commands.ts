import type { Editor, JSONContent, Range } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { BlockDefinition } from './registry';

/**
 * Slash-menu behaviour, as in Notion: remove the typed `/query`, then turn the
 * current block into `block` if it is now empty, or insert a new `block` below it.
 */
export function insertBlockFromSlash(editor: Editor, range: Range, block: BlockDefinition): void {
  editor.chain().focus().deleteRange(range).run();

  const { $from } = editor.state.selection;
  const empty = $from.parent.isTextblock && $from.parent.content.size === 0;
  if (!empty && block.convertible) {
    const after = $from.after($from.depth);
    editor
      .chain()
      .insertContentAt(after, { type: 'paragraph' })
      .command(({ tr }) => {
        tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
        return true;
      })
      .run();
  }
  block.apply(editor.chain().focus()).run();
}

/** Put the cursor inside the block at `pos` (as reported by the drag handle). */
export function selectBlockAt(editor: Editor, pos: number) {
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size))));
      return true;
    });
}

export function convertBlockAt(editor: Editor, pos: number, block: BlockDefinition): void {
  block.apply(selectBlockAt(editor, pos)).run();
}

export function deleteBlockAt(editor: Editor, pos: number, node: PMNode): void {
  editor
    .chain()
    .focus()
    .deleteRange({ from: pos, to: pos + node.nodeSize })
    .run();
}

/**
 * Copy of a node's JSON with every block id cleared, so UniqueID assigns fresh ones.
 * (UniqueID only de-duplicates ids among newly inserted nodes, not against the
 * original block.)
 */
export function withoutBlockIds(json: JSONContent): JSONContent {
  return {
    ...json,
    ...(json.attrs && { attrs: { ...json.attrs, id: null } }),
    ...(json.content && { content: json.content.map(withoutBlockIds) }),
  };
}

/** Insert a copy, with new block ids, right after the block. */
export function duplicateBlockAt(editor: Editor, pos: number, node: PMNode): void {
  editor
    .chain()
    .focus()
    .insertContentAt(pos + node.nodeSize, withoutBlockIds(node.toJSON() as JSONContent))
    .run();
}

/** Insert an empty block below and open the slash menu in it, like Notion's "+" button. */
export function insertBelowWithSlash(editor: Editor, pos: number, node: PMNode): void {
  const after = pos + node.nodeSize;
  editor
    .chain()
    .focus()
    .insertContentAt(after, { type: 'paragraph', content: [{ type: 'text', text: '/' }] })
    .command(({ tr }) => {
      tr.setSelection(TextSelection.create(tr.doc, after + 2));
      return true;
    })
    .run();
}

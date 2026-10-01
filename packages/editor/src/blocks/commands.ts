import type { Command, Editor, JSONContent, Range } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { BlockDefinition } from './registry';

/**
 * Slash-menu behaviour, as in Notion: remove the typed `/query`; if the block still
 * has text, continue in a new empty block below it; then turn that empty block into
 * `block`. Inline items (inline equation) are inserted at the cursor instead.
 */
export async function insertBlockFromSlash(
  editor: Editor,
  range: Range,
  block: BlockDefinition,
): Promise<void> {
  editor.chain().focus().deleteRange(range).run();

  const args = block.prepare ? await block.prepare(editor) : {};
  if (!args || editor.isDestroyed) {
    editor.commands.focus();
    return;
  }

  const { $from } = editor.state.selection;
  const empty = $from.parent.isTextblock && $from.parent.content.size === 0;
  if (!empty && block.group !== 'inline') {
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
  block.apply(editor.chain().focus(), args).run();
  block.after?.(editor, args);
}

/** Command: replace the textblock at the cursor with `content`, then place the cursor after it. */
export function replaceCurrentBlock(content: JSONContent): Command {
  return ({ state, tr, dispatch }) => {
    const { $from } = state.selection;
    if ($from.depth < 1) return false;
    const node = state.schema.nodeFromJSON(content);
    if (dispatch) {
      const start = $from.before($from.depth);
      tr.replaceWith(start, $from.after($from.depth), node);
      const after = start + node.nodeSize;
      if (after >= tr.doc.content.size) tr.insert(after, state.schema.nodes.paragraph!.create());
      tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
    }
    return true;
  };
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
  block.apply(selectBlockAt(editor, pos), {}).run();
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

import { Extension, InputRule, type Editor } from '@tiptap/core';
import Mathematics from '@tiptap/extension-mathematics';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { UiBridgeHandle } from '../services';

/** Replace the (empty) block at the cursor with a block equation and open its editor. */
export function insertBlockEquation(editor: Editor): void {
  const { $from } = editor.state.selection;
  const start = $from.before($from.depth);
  const end = $from.after($from.depth);
  const replace = $from.parent.content.size === 0;
  editor
    .chain()
    .focus()
    .insertContentAt(replace ? { from: start, to: end } : end, {
      type: 'blockMath',
      attrs: { latex: '' },
    })
    .run();
  openMathAt(editor, replace ? start : end);
}

/** Insert an inline equation at the cursor (from the selected text, if any) and edit it. */
export function insertInlineEquation(editor: Editor): void {
  const { from, to } = editor.state.selection;
  const latex = editor.state.doc.textBetween(from, to);
  editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, { type: 'inlineMath', attrs: { latex } })
    .run();
  if (!latex) openMathAt(editor, from);
}

function openMathAt(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (node) editor.storage.uiBridge.ref.current.editMath?.(node, pos);
}

/** KaTeX equations; clicking one opens the equation editor owned by <PageEditor>. */
export function mathExtensions(bridge: UiBridgeHandle) {
  const onClick = (node: PMNode, pos: number) => bridge.current.editMath?.(node, pos);
  return [
    Mathematics.configure({
      blockOptions: { onClick },
      inlineOptions: { onClick },
      katexOptions: { throwOnError: false, strict: false },
    }),
    Extension.create({
      name: 'blockEquationShortcut',
      // Ahead of Mathematics' own `$…$` rule, which would otherwise claim "$$".
      priority: 200,
      addInputRules() {
        return [
          new InputRule({
            find: /^\$\$\s$/,
            handler: ({ range, chain }) => {
              chain().deleteRange(range).run();
              queueMicrotask(() => insertBlockEquation(this.editor));
            },
          }),
        ];
      },
    }),
  ];
}

import { Extension, InputRule, type Editor } from '@tiptap/core';
import Mathematics from '@tiptap/extension-mathematics';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
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

const macrosKey = new PluginKey<number>('mathMacros');

/** The workspace's KaTeX macros this editor renders with. */
export function mathMacros(editor: Editor): Record<string, string> {
  return (editor.storage as { mathMacros?: { katex: { macros: Record<string, string> } } })
    .mathMacros!.katex.macros;
}

/** Render with new macros: every equation is drawn again. */
export function setMathMacros(editor: Editor, macros: Record<string, string>): void {
  const current = mathMacros(editor);
  if (JSON.stringify(current) === JSON.stringify(macros)) return;
  for (const key of Object.keys(current)) delete current[key];
  Object.assign(current, macros);
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(macrosKey, true));
}

/** KaTeX equations; clicking one opens the equation editor owned by <PageEditor>. */
export function mathExtensions(bridge: UiBridgeHandle) {
  const onClick = (node: PMNode, pos: number) => bridge.current.editMath?.(node, pos);
  // Shared with every equation's node view; macros are filled in from the workspace.
  const katex = { throwOnError: false, strict: false, macros: {} as Record<string, string> };
  return [
    Mathematics.configure({
      blockOptions: { onClick },
      inlineOptions: { onClick },
      katexOptions: katex,
    }),
    Extension.create({
      name: 'mathMacros',
      addStorage: () => ({ katex }),
      addProseMirrorPlugins() {
        // A version on every equation's decorations: bumping it redraws them (their
        // node views have no update(), so ProseMirror makes new ones).
        return [
          new Plugin({
            key: macrosKey,
            state: {
              init: () => 0,
              apply: (tr, version) => (tr.getMeta(macrosKey) ? version + 1 : version),
            },
            props: {
              decorations(state) {
                const version = macrosKey.getState(state) ?? 0;
                if (version === 0) return DecorationSet.empty;
                const decorations: Decoration[] = [];
                state.doc.descendants((node, pos) => {
                  if (node.type.name === 'blockMath' || node.type.name === 'inlineMath') {
                    decorations.push(
                      Decoration.node(pos, pos + node.nodeSize, {
                        'data-macros': String(version),
                      }),
                    );
                  }
                });
                return DecorationSet.create(state.doc, decorations);
              },
            },
          }),
        ];
      },
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

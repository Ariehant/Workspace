import { Extension, InputRule, type Editor } from '@tiptap/core';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';

export type ToggleLevel = 0 | 1 | 2 | 3;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toggleBlock: {
      /**
       * Turn the current block into a toggle (level 0) or toggle heading (1–3).
       * The block's text becomes the toggle's title, as in Notion.
       */
      setToggle: (level: ToggleLevel) => ReturnType;
      /** If the cursor is in a toggle title, turn the toggle back into plain blocks. */
      unwrapToggleTitle: () => ReturnType;
    };
  }
}

/** Expand the toggle at `pos` (open state is per view, not stored in the doc). */
export function openToggleAt(editor: Editor, pos: number): void {
  const dom = editor.view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement) || dom.classList.contains('is-open')) return;
  dom.querySelector<HTMLButtonElement>(':scope > button')?.click();
}

/** Toggle title, optionally styled as a heading (`level` 1–3). */
const ToggleSummary = DetailsSummary.extend({
  addAttributes() {
    return {
      level: {
        default: 0,
        parseHTML: (el) => Number(el.getAttribute('data-level') ?? 0),
        renderHTML: (attrs) => (attrs.level ? { 'data-level': attrs.level } : {}),
      },
    };
  },
});

const ToggleCommands = Extension.create({
  name: 'toggleBlock',

  addCommands() {
    return {
      setToggle:
        (level) =>
        ({ state, chain, commands, editor }) => {
          const { $from } = state.selection;
          if ($from.parent.type.name === 'detailsSummary') {
            return commands.updateAttributes('detailsSummary', { level });
          }
          if (!$from.parent.isTextblock) return false;
          const start = $from.before($from.depth);
          const end = $from.after($from.depth);
          const text = $from.parent.content;
          // New toggles start open so their content can be typed straight away.
          queueMicrotask(() => openToggleAt(editor, start));
          return chain()
            .insertContentAt(
              { from: start, to: end },
              {
                type: 'details',
                content: [
                  { type: 'detailsSummary', attrs: { level }, content: text.toJSON() ?? [] },
                  { type: 'detailsContent', content: [{ type: 'paragraph' }] },
                ],
              },
            )
            .setTextSelection(start + 2 + text.size)
            .run();
        },
      unwrapToggleTitle:
        () =>
        ({ state, commands }) =>
          state.selection.$from.parent.type.name === 'detailsSummary'
            ? commands.unsetDetails()
            : true,
    };
  },

  addInputRules() {
    // Notion: "> " starts a toggle list ("\"" + space makes a quote instead).
    return [
      new InputRule({
        find: /^>\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).setToggle(0).run();
        },
      }),
    ];
  },
});

export const ToggleExtensions = [
  // Open/closed state stays per view, like Notion (each person folds toggles for
  // themselves). Persisting it would also reset block ids: the upstream click
  // handler replaces all of the node's attributes.
  Details.configure({ persist: false, HTMLAttributes: { class: 'ws-toggle' } }),
  ToggleSummary,
  DetailsContent,
  ToggleCommands,
];

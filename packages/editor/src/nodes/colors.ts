import { Extension, Mark, mergeAttributes } from '@tiptap/core';

/** Notion's palette. Stored by name so light and dark themes can each render it. */
export const COLOR_NAMES = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
export type ColorName = (typeof COLOR_NAMES)[number];
/** `red` colors text; `red_background` colors the background. */
export type ColorValue = ColorName | `${ColorName}_background`;

export const COLOR_LABELS: Record<ColorName, string> = {
  gray: 'Gray',
  brown: 'Brown',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red',
};

export function isColorValue(value: unknown): value is ColorValue {
  if (typeof value !== 'string') return false;
  const name = value.replace(/_background$/, '');
  return (COLOR_NAMES as readonly string[]).includes(name);
}

/** Blocks that can be colored as a whole (callouts have their own `color`). */
export const COLORABLE_BLOCKS = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'details',
  'codeBlock',
];

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textColor: {
      /** Color the selected text; `null` removes the color. */
      setTextColor: (value: ColorValue | null) => ReturnType;
      /** Color the block at `pos` (as reported by the drag handle); `null` resets it. */
      setBlockColor: (pos: number, value: ColorValue | null) => ReturnType;
    };
  }
}

const colorAttr = {
  default: null,
  parseHTML: (el: HTMLElement) => {
    const v = el.getAttribute('data-color');
    return isColorValue(v) ? v : null;
  },
  renderHTML: (attrs: Record<string, unknown>) =>
    attrs.color ? { 'data-color': attrs.color } : {},
};

/** Inline text or background color (one per span, like Notion). */
export const TextColor = Mark.create({
  name: 'color',
  addAttributes: () => ({ color: colorAttr }),
  parseHTML: () => [{ tag: 'span[data-color]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, { class: 'ws-color' }),
    0,
  ],
  addCommands() {
    return {
      setTextColor:
        (value) =>
        ({ commands }) =>
          value ? commands.setMark(this.name, { color: value }) : commands.unsetMark(this.name),
      setBlockColor:
        (pos, value) =>
        ({ tr, state, dispatch }) => {
          const node = state.doc.nodeAt(pos);
          if (!node || !('color' in node.attrs)) return false;
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, color: value });
          return true;
        },
    };
  },
});

/** `color` attribute on block types, rendered as `data-color`. */
export const BlockColor = Extension.create({
  name: 'blockColor',
  addGlobalAttributes: () => [{ types: COLORABLE_BLOCKS, attributes: { color: colorAttr } }],
});

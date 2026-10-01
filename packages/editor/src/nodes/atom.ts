import { Node, mergeAttributes, type Attributes } from '@tiptap/core';
import { ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import type { ComponentType } from 'react';

/**
 * A block-level atom (no editable content) rendered by a React view: page links,
 * breadcrumbs, media, bookmarks and embeds.
 */
export function atomBlock(
  name: string,
  view: ComponentType<ReactNodeViewProps>,
  attrs: Attributes = {},
) {
  return Node.create({
    name,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes: () => attrs,
    parseHTML: () => [{ tag: `div[data-type="${name}"]` }],
    renderHTML: ({ HTMLAttributes }) => [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': name }),
    ],
    addNodeView: () => ReactNodeViewRenderer(view),
  });
}

/** An attribute stored as `data-<name>` in HTML. */
export function dataAttr(name: string, defaultValue: unknown = null) {
  const key = `data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  return {
    default: defaultValue,
    parseHTML: (el: HTMLElement) => {
      const value = el.getAttribute(key);
      if (value === null) return defaultValue;
      return typeof defaultValue === 'number' ? Number(value) : value;
    },
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs[name] === null || attrs[name] === undefined ? {} : { [key]: attrs[name] },
  };
}

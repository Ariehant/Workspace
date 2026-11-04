import { useLayoutEffect, type KeyboardEvent, type RefObject } from 'react';

/**
 * Keyboard use of a page tree (the WAI-ARIA tree pattern): one Tab stop per tree, the
 * current page's row (or the first); ↑ ↓ Home End move between the rows shown; → expands a
 * row or goes to its first child; ← collapses it or goes to its parent; Enter opens the page.
 * Rows are `li[role=treeitem]` with `data-page-id`.
 */

const ITEM = 'li[role="treeitem"]';

const itemsOf = (tree: HTMLElement) => [...tree.querySelectorAll<HTMLElement>(ITEM)];

/** Give the tree a single Tab stop: `item`, or the selected row, or the first. */
function setTabStop(tree: HTMLElement, item?: HTMLElement) {
  const items = itemsOf(tree);
  const stop = item ?? items.find((el) => el.getAttribute('aria-selected') === 'true') ?? items[0];
  for (const el of items) el.tabIndex = el === stop ? 0 : -1;
}

/** Keep one Tab stop in the tree as its rows change. */
export function useTreeTabStop(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const tree = ref.current;
    if (!tree) return;
    const focused = tree.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).closest<HTMLElement>(ITEM)
      : null;
    setTabStop(tree, focused ?? undefined);
  });
}

export interface TreeKeyActions {
  isExpanded(id: string): boolean;
  toggle(id: string): void;
  open(id: string): void;
}

export function onTreeKeyDown(event: KeyboardEvent<HTMLElement>, actions: TreeKeyActions) {
  const item = event.target as HTMLElement;
  // Keys on a row's own buttons (its menu, "add inside") are theirs.
  if (!item.matches(ITEM)) return;
  const tree = event.currentTarget;
  const id = item.dataset.pageId!;
  const items = itemsOf(tree);
  const at = items.indexOf(item);
  const go = (target: HTMLElement | null | undefined) => {
    if (!target) return;
    setTabStop(tree, target);
    target.focus();
  };
  switch (event.key) {
    case 'ArrowDown':
      go(items[at + 1]);
      break;
    case 'ArrowUp':
      go(items[at - 1]);
      break;
    case 'Home':
      go(items[0]);
      break;
    case 'End':
      go(items[items.length - 1]);
      break;
    case 'ArrowRight':
      if (!actions.isExpanded(id)) actions.toggle(id);
      else go(item.querySelector<HTMLElement>(`:scope > [role="group"] > ${ITEM}`));
      break;
    case 'ArrowLeft':
      if (actions.isExpanded(id)) actions.toggle(id);
      else go(item.parentElement?.closest<HTMLElement>(ITEM));
      break;
    case 'Enter':
    case ' ':
      actions.open(id);
      break;
    default:
      return;
  }
  event.preventDefault();
}

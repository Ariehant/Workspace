import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/**
 * A virtualizer for a list inside the page's scroll area (`[data-scroll-root]`):
 * only the lines in view are rendered. `bodyRef` goes on the list's container; when
 * `enabled` is false every line renders and `virtualizer` has no items.
 */
export function usePageVirtualizer(options: {
  count: number;
  enabled: boolean;
  estimateSize(index: number): number;
  getItemKey(index: number): string | number;
  overscan?: number;
}): {
  bodyRef: RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLElement, Element>;
} {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const { enabled } = options;
  useEffect(() => {
    if (!enabled) return;
    const body = bodyRef.current;
    const root = body?.closest<HTMLElement>('[data-scroll-root]');
    if (!body || !root) return;
    // Where the list starts inside the scrolling page; changes when content above it
    // changes size.
    const measure = () => {
      setScrollRoot(root);
      setScrollMargin(
        body.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root.firstElementChild ?? root);
    return () => observer.disconnect();
  }, [enabled]);
  const virtualizer = useVirtualizer({
    count: enabled ? options.count : 0,
    getScrollElement: () => scrollRoot,
    estimateSize: options.estimateSize,
    overscan: options.overscan ?? 8,
    scrollMargin,
    getItemKey: options.getItemKey,
  });
  return { bodyRef, virtualizer };
}

/**
 * Draws the lines in a virtual window, reusing the element a line had last time while
 * `owner` is the same object: pass the component's props, which stay the same object when only
 * its own state changed (a scroll), and are new when anything it draws from may have. React
 * leaves a reused element alone, so a scroll draws only the lines coming into view. (A
 * 50,000-row table drew every line in view on each scroll frame; that allocation, while a
 * garbage collection was marking, held its first scroll after a pause for a quarter second.)
 */
export function useReusedLines<K>(owner: object): (key: K, draw: () => ReactNode) => ReactNode {
  const last = useRef<{ owner: object; lines: Map<K, ReactNode> }>(null);
  const before = last.current?.owner === owner ? last.current.lines : null;
  const lines = new Map<K, ReactNode>();
  useEffect(() => {
    last.current = { owner, lines };
  });
  return (key, draw) => {
    const element = before?.has(key) ? before.get(key) : draw();
    lines.set(key, element);
    return element;
  };
}

import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, useState, type RefObject } from 'react';

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

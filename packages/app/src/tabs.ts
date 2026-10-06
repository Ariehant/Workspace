import type { TabsState } from '@workspace/core';
import { useCallback, useEffect, useMemo, useRef } from 'react';

/** What a middle-click on can open in a new tab: links to pages, sidebar rows, results. */
const NAV_TARGETS = 'a, button, [role="treeitem"], [role="option"], [data-testid="mention"]';

/**
 * Set while a Ctrl+click (or middle-click) is being handled, so whatever navigates in
 * response opens a new tab instead. Middle-clicks are replayed as Ctrl+clicks, since
 * they don't fire `click` at all.
 */
export function useNewTabIntent() {
  const intent = useRef(false);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return;
      intent.current = true;
      // Navigation happens in this same event; anything later is a plain click.
      setTimeout(() => (intent.current = false));
    };
    const onAuxClick = (event: MouseEvent) => {
      if (event.button !== 1 || !(event.target instanceof Element)) return;
      const target = event.target.closest(NAV_TARGETS);
      if (!target || target.closest('[role="tab"]')) return;
      event.preventDefault();
      // From the element clicked, so the click reaches its handler as it bubbles.
      event.target.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
    };
    window.addEventListener('click', onClick, true);
    window.addEventListener('auxclick', onAuxClick, true);
    return () => {
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('auxclick', onAuxClick, true);
    };
  }, []);
  return useMemo(
    () => ({
      /** True (once) when the click being handled asked for a new tab. */
      take(): boolean {
        const wanted = intent.current;
        intent.current = false;
        return wanted;
      },
    }),
    [],
  );
}

const scrollRoot = () => document.querySelector<HTMLElement>('[data-testid="page-scroll"]');

/**
 * Each tab's scroll position: `save()` before leaving a tab, and it's put back when the
 * tab shows again (once its content has loaded far enough to scroll there).
 */
export function useTabScroll(tabs: TabsState) {
  const saved = useRef(new Map<string, number>());
  const activeId = tabs.tabs[tabs.active]!.id;
  const active = useRef(activeId);
  active.current = activeId;

  const save = useCallback(() => {
    const el = scrollRoot();
    if (el) saved.current.set(active.current, el.scrollTop);
  }, []);

  useEffect(() => {
    const top = saved.current.get(activeId);
    if (!top) return;
    let frames = 0;
    let raf = 0;
    const restore = () => {
      const el = scrollRoot();
      if (el && (el.scrollHeight - el.clientHeight >= top || ++frames > 60)) {
        el.scrollTop = top;
        return;
      }
      raf = requestAnimationFrame(restore);
    };
    raf = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(raf);
  }, [activeId]);

  // Forget closed tabs.
  useEffect(() => {
    const open = new Set(tabs.tabs.map((t) => t.id));
    for (const id of saved.current.keys()) if (!open.has(id)) saved.current.delete(id);
  }, [tabs.tabs]);

  return useMemo(() => ({ save }), [save]);
}

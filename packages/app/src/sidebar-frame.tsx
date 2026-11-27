/**
 * Where the sidebar sits: in the layout while it's open (sliding in and out as it opens and
 * closes), and, while it's closed, shown over the page when the mouse rests on the window's left
 * edge (a peek), hiding again when the mouse leaves it.
 */
import { cn } from '@workspace/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** How long the mouse rests on the edge before the peek shows, and leaves it before it hides. */
export const PEEK_SHOW_MS = 150;
export const PEEK_HIDE_MS = 300;
const SLIDE_MS = 160;

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** A menu or dialog is open (one opened from the peek keeps it shown). */
const popupOpen = () =>
  !!document.querySelector('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]');

export type SidebarMode = 'docked' | 'peek';

export function SidebarFrame({
  open,
  width,
  children,
}: {
  open: boolean;
  width: number;
  children: (mode: SidebarMode) => ReactNode;
}) {
  // In the layout (docked), and the width while it slides (null: not sliding).
  const [docked, setDocked] = useState(open);
  const [slideWidth, setSlideWidth] = useState<number | null>(null);
  const [phase, setPhase] = useState<'opening' | 'closing' | null>(null);
  const [peek, setPeek] = useState(false);
  const hovering = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
  const clear = () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  };
  useEffect(() => clear, []);

  // Opened or closed: start sliding (worked out while rendering, from the last value seen).
  const [seen, setSeen] = useState(open);
  if (open !== seen) {
    setSeen(open);
    if ((open && peek) || reducedMotion()) {
      // Pinned from the peek, or no motion wanted: there at once.
      setPeek(false);
      setDocked(open);
      setSlideWidth(null);
      setPhase(null);
    } else if (open) {
      setDocked(true);
      setSlideWidth(0);
      setPhase('opening');
    } else {
      setSlideWidth(width);
      setPhase('closing');
    }
  }

  // The slide itself: to its end width on the next frames, then out of the way.
  useEffect(() => {
    if (!phase) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setSlideWidth(phase === 'opening' ? width : 0));
    });
    const done = setTimeout(() => {
      if (phase === 'closing') setDocked(false);
      setSlideWidth(null);
      setPhase(null);
    }, SLIDE_MS);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      clearTimeout(done);
    };
  }, [phase, width]);

  const showSoon = () => {
    clear();
    later(PEEK_SHOW_MS, () => setPeek(true));
  };
  const hideSoon = () => {
    clear();
    const check = () => {
      if (hovering.current || popupOpen()) later(PEEK_HIDE_MS, check);
      else setPeek(false);
    };
    later(PEEK_HIDE_MS, check);
  };

  if (docked) {
    return (
      <div
        className={cn(
          'flex h-full shrink-0',
          slideWidth !== null && 'overflow-hidden transition-[width] duration-150 ease-out',
        )}
        style={slideWidth !== null ? { width: slideWidth } : undefined}
      >
        {children('docked')}
      </div>
    );
  }
  return (
    <>
      <div
        aria-hidden
        data-testid="sidebar-edge"
        className="absolute inset-y-0 left-0 z-30 w-2"
        onMouseEnter={showSoon}
        // Left without going over the peek (it cancels this when the mouse enters it).
        onMouseLeave={() => (peek ? hideSoon() : clear())}
      />
      {peek && (
        <div
          data-testid="sidebar-peek"
          className="absolute inset-y-2 left-0 z-40 flex overflow-hidden rounded-r-lg shadow-2xl"
          onMouseEnter={() => {
            hovering.current = true;
            clear();
          }}
          onMouseLeave={() => {
            hovering.current = false;
            hideSoon();
          }}
        >
          {children('peek')}
        </div>
      )}
    </>
  );
}

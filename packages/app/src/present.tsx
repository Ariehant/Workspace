/**
 * Presentation mode (Phase 8 N6, #6): a page as slides, full screen. Each divider starts a
 * new slide; the first shows the page's title. Arrow keys, Space and Page Up/Down move,
 * Home and End go to the ends, Escape (or leaving full screen) ends it.
 *
 * The page is rendered once, read-only, and the blocks outside the slide are hidden, so
 * everything looks as it does on the page (databases, diagrams, equations…).
 */
import { getPage, type PageId } from '@workspace/core';
import { PageEditor, PageIcon, type Editor } from '@workspace/editor';
import { IconButton } from '@workspace/ui';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from './context';
import { useEditorServices } from './editor-services';
import { useDoc } from './hooks';

/** A top-level block, as slides see it. */
export interface SlideBlock {
  divider: boolean;
  /** An empty paragraph. */
  empty: boolean;
}

/** A slide: the top-level blocks `start` to `end` (exclusive). */
export interface SlideRange {
  start: number;
  end: number;
}

/**
 * Split a page's blocks into slides at its dividers (which aren't shown). The first slide
 * is kept even if empty (it has the title); the others are dropped when they hold nothing
 * but empty paragraphs.
 */
export function slideRanges(blocks: readonly SlideBlock[]): SlideRange[] {
  const slides: SlideRange[] = [];
  let start = 0;
  blocks.forEach((block, i) => {
    if (!block.divider) return;
    slides.push({ start, end: i });
    start = i + 1;
  });
  slides.push({ start, end: blocks.length });
  return slides.filter(
    (slide, i) => i === 0 || blocks.slice(slide.start, slide.end).some((b) => !b.empty),
  );
}

/** CSS hiding the editor's top-level blocks outside `slide` (`nth-child` counts from 1). */
export function slideCss(scope: string, slide: SlideRange): string {
  const root = `${scope} .ProseMirror:not(.ProseMirror .ProseMirror)`;
  const before = slide.start > 0 ? `${root} > :nth-child(-n + ${slide.start})` : null;
  const after = `${root} > :nth-child(n + ${slide.end + 1})`;
  return `${[before, after].filter(Boolean).join(',\n')} { display: none !important; }`;
}

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter']);
const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']);

export function Presentation({ pageId, onClose }: { pageId: PageId; onClose(): void }) {
  const { client, workspace, platform } = useApp();
  const doc = useDoc(client, pageId);
  const services = useEditorServices(pageId);
  const page = getPage(workspace, pageId);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [blocks, setBlocks] = useState<SlideBlock[]>([]);
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The slides follow the page (someone may be editing it meanwhile).
  useEffect(() => {
    if (!editor) return;
    const read = () => {
      const out: SlideBlock[] = [];
      editor.state.doc.forEach((node) =>
        out.push({
          divider: node.type.name === 'horizontalRule',
          empty: node.type.name === 'paragraph' && node.content.size === 0,
        }),
      );
      setBlocks(out);
    };
    read();
    editor.on('update', read);
    return () => void editor.off('update', read);
  }, [editor]);
  const slides = slideRanges(blocks);
  const current = Math.max(0, Math.min(index, slides.length - 1));
  const slide = slides[current] ?? { start: 0, end: 0 };
  const go = (to: number) => setIndex(Math.max(0, Math.min(to, slides.length - 1)));

  // Keys move between slides; Escape ends.
  const last = slides.length - 1;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const to = (n: number) => setIndex(Math.max(0, Math.min(n, last)));
      if (event.key === 'Escape') onClose();
      else if (NEXT_KEYS.has(event.key)) to(current + 1);
      else if (PREVIOUS_KEYS.has(event.key)) to(current - 1);
      else if (event.key === 'Home') to(0);
      else if (event.key === 'End') to(last);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current, last, onClose]);

  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  // Full screen while presenting; leaving it (the browser's Escape) ends the presentation.
  useEffect(() => {
    const root = rootRef.current;
    let entered = false;
    const onChange = () => {
      if (document.fullscreenElement) entered = true;
      else if (entered) close.current();
    };
    document.addEventListener('fullscreenchange', onChange);
    root?.requestFullscreen?.().catch(() => {});
    scrollRef.current?.focus();
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Presenting ${page?.title || 'Untitled'}`}
      tabIndex={-1}
      data-testid="presentation"
      className="ws-presentation fixed inset-0 z-50 flex flex-col bg-surface outline-none"
    >
      <style>{slideCss('.ws-presentation', slide)}</style>
      {/* Focusable, so a long slide scrolls from the keyboard too. */}
      <div
        ref={scrollRef}
        role="region"
        aria-label={`Slide ${current + 1} of ${Math.max(slides.length, 1)}`}
        tabIndex={0}
        className="flex min-h-0 flex-1 overflow-y-auto outline-none"
      >
        <div
          className="m-auto w-full max-w-[1000px] px-16 py-12"
          style={{ zoom: 1.4 }}
          data-testid="slide"
          data-slide={current + 1}
        >
          {current === 0 && (
            <div className="mb-6 flex flex-col gap-3">
              {page?.icon && <PageIcon icon={page.icon} size={56} fileUrl={platform.fileUrl} />}
              <h1 className="text-5xl font-bold">{page?.title || 'Untitled'}</h1>
            </div>
          )}
          {doc && (
            <PageEditor
              doc={doc}
              services={services}
              editable={false}
              nested
              onEditor={setEditor}
            />
          )}
        </div>
      </div>
      <footer className="flex h-12 shrink-0 items-center justify-center gap-2 text-sm text-muted">
        <IconButton
          label="Previous slide (←)"
          className="disabled:opacity-30"
          disabled={current === 0}
          onClick={() => go(current - 1)}
        >
          <ChevronLeft size={18} />
        </IconButton>
        <span className="min-w-14 text-center tabular-nums" data-testid="slide-count">
          {current + 1} / {Math.max(slides.length, 1)}
        </span>
        <IconButton
          label="Next slide (→)"
          className="disabled:opacity-30"
          disabled={current >= slides.length - 1}
          onClick={() => go(current + 1)}
        >
          <ChevronRight size={18} />
        </IconButton>
        <IconButton label="End presentation (Esc)" className="absolute right-3" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </footer>
    </div>
  );
}

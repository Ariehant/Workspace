import { PageIcon } from './page-icon';
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { cn } from '@workspace/ui';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EditorServices, PageRef } from './services';

export interface PagePickerProps {
  services: EditorServices;
  anchor: DOMRect;
  /** Only offer database pages (for linked views). */
  databasesOnly?: boolean;
  onPick(page: PageRef | null): void;
}

/** Search-as-you-type list of pages, anchored at the cursor. */
export function PagePicker({ services, anchor, databasesOnly, onPick }: PagePickerProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const pages = useMemo(() => {
    const q = query.trim().toLowerCase();
    return services
      .listPages()
      .filter((p) => !p.inTrash && (!databasesOnly || p.isDatabase))
      .filter((p) => !q || (p.title || 'untitled').toLowerCase().includes(q))
      .slice(0, 50);
  }, [services, query, databasesOnly]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    void computePosition({ getBoundingClientRect: () => anchor }, el, {
      placement: 'bottom-start',
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => Object.assign(el.style, { left: `${x}px`, top: `${y}px` }));
  }, [anchor]);

  const choose = (page: PageRef | undefined) => page && onPick(page);

  return (
    <div
      ref={ref}
      className="ws-floating w-80 rounded-lg bg-menu p-1 text-sm text-fg shadow-menu"
      data-testid="page-picker"
    >
      <input
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onBlur={() => onPick(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onPick(null);
          else if (event.key === 'ArrowDown') setSelected((i) => Math.min(i + 1, pages.length - 1));
          else if (event.key === 'ArrowUp') setSelected((i) => Math.max(i - 1, 0));
          else if (event.key === 'Enter') choose(pages[selected]);
          else return;
          event.preventDefault();
        }}
        placeholder="Search for a page…"
        aria-label="Search pages"
        className="mb-1 h-8 w-full rounded border border-line bg-surface px-2 outline-none focus:border-accent"
      />
      <div role="listbox" aria-label="Pages" className="max-h-64 overflow-y-auto">
        {pages.length === 0 && <div className="px-2 py-1.5 text-muted">No pages found</div>}
        {pages.map((page, index) => (
          <button
            key={page.id}
            type="button"
            role="option"
            aria-selected={index === selected}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setSelected(index)}
            onClick={() => choose(page)}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left',
              index === selected && 'bg-hover',
            )}
          >
            <span className="flex size-5 items-center justify-center text-muted">
              <PageIcon icon={page.icon} size={16} fileUrl={services.fileUrl} />
            </span>
            <span className="truncate">{page.title || 'Untitled'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

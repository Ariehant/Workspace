import { PageIcon } from '@workspace/editor';
import { Popover, PopoverContent, PopoverTrigger, cn } from '@workspace/ui';
import { ArrowUpLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from './context';
import { useNavigation } from './navigation';
import type { Backlink } from './platform';

/** How a page shows its backlinks (a per-page setting, like Notion's). */
export type BacklinksMode = 'popover' | 'expanded' | 'off';
export const backlinksSettingKey = (pageId: string) => `backlinks.${pageId}`;

/** Tell every mounted `useBacklinksMode` of a page about a change (menu → list). */
const modeListeners = new Set<(pageId: string, mode: BacklinksMode) => void>();

/** The display setting for a page's backlinks, saved in settings. */
export function useBacklinksMode(pageId: string): [BacklinksMode, (mode: BacklinksMode) => void] {
  const { platform } = useApp();
  const [mode, setMode] = useState<{ pageId: string; mode: BacklinksMode } | null>(null);
  useEffect(() => {
    let live = true;
    void platform.getSetting<BacklinksMode>(backlinksSettingKey(pageId)).then(
      (m) =>
        live &&
        // A change made while loading wins.
        setMode((current) =>
          current?.pageId === pageId ? current : { pageId, mode: m ?? 'popover' },
        ),
    );
    const listener = (id: string, next: BacklinksMode) => {
      if (id === pageId) setMode({ pageId, mode: next });
    };
    modeListeners.add(listener);
    return () => {
      live = false;
      modeListeners.delete(listener);
    };
  }, [platform, pageId]);
  const set = (next: BacklinksMode) => {
    platform.setSetting(backlinksSettingKey(pageId), next);
    for (const listener of modeListeners) listener(pageId, next);
  };
  return [mode?.pageId === pageId ? mode.mode : 'popover', set];
}

/** Backlinks of a page, refreshed when pages change (the index follows edits). */
function useBacklinks(pageId: string): Backlink[] {
  const { platform, pages } = useApp();
  const [links, setLinks] = useState<{ pageId: string; links: Backlink[] }>({ pageId, links: [] });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void platform.backlinks(pageId).then((l) => live && setLinks({ pageId, links: l }));
      }, 150);
    };
    load();
    const off = pages.subscribe(load);
    return () => {
      live = false;
      clearTimeout(timer);
      off();
    };
  }, [platform, pages, pageId]);
  return links.pageId === pageId ? links.links : [];
}

/** One entry per linking page, with the blocks that link. */
function group(links: Backlink[]) {
  const byPage = new Map<string, { page: Backlink; blocks: Backlink[] }>();
  for (const link of links) {
    const entry = byPage.get(link.id) ?? { page: link, blocks: [] };
    entry.blocks.push(link);
    byPage.set(link.id, entry);
  }
  return [...byPage.values()];
}

/** "N backlinks" under the page title: a popover, a list, or nothing (per page). */
export function Backlinks({ pageId }: { pageId: string }) {
  const { platform } = useApp();
  const { navigateToBlock } = useNavigation();
  const [mode] = useBacklinksMode(pageId);
  const links = useBacklinks(pageId);
  const pages = group(links);
  if (mode === 'off' || pages.length === 0) return null;
  const label = `${pages.length} backlink${pages.length === 1 ? '' : 's'}`;
  const list = (
    <ul className="flex flex-col gap-0.5" data-testid="backlinks-list">
      {pages.map(({ page, blocks }) => (
        <li key={page.id}>
          <button
            type="button"
            onClick={() => navigateToBlock(page.id, blocks[0]?.blockId ?? null)}
            className="flex w-full flex-col rounded px-2 py-1 text-left hover:bg-hover"
            data-testid="backlink"
          >
            <span className="flex items-center gap-1.5 text-sm">
              <PageIcon
                icon={page.icon}
                size={14}
                fileUrl={platform.fileUrl}
                className="text-muted"
              />
              <span className="truncate font-medium underline decoration-faint underline-offset-2">
                {page.title || 'Untitled'}
              </span>
              {blocks.some((b) => b.kind === 'relation') && (
                <span className="text-xs text-faint">relation</span>
              )}
            </span>
            {blocks
              .filter((b) => b.snippet && b.kind !== 'relation')
              .slice(0, 2)
              .map((b, i) => (
                <span
                  key={i}
                  className="truncate pl-5 text-xs text-muted"
                  data-testid="backlink-snippet"
                >
                  {b.snippet}
                </span>
              ))}
          </button>
        </li>
      ))}
    </ul>
  );
  const trigger = (
    <span className="flex items-center gap-1">
      <ArrowUpLeft size={14} /> {label}
    </span>
  );
  if (mode === 'expanded') {
    return (
      <div className="mt-2 border-b border-line pb-2 text-sm" data-testid="backlinks">
        <p className="mb-1 flex h-7 items-center px-2 text-muted">{trigger}</p>
        {list}
      </div>
    );
  }
  return (
    <div className="mt-1" data-testid="backlinks">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn('flex h-7 items-center rounded px-2 text-sm text-muted hover:bg-hover')}
          >
            {trigger}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-1">
          {list}
        </PopoverContent>
      </Popover>
    </div>
  );
}

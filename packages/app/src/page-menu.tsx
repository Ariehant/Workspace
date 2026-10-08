import { countWords, pageText, type PageFont, type PageMeta } from '@workspace/core';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuSeparator,
  MenuTrigger,
  IconButton,
  cn,
} from '@workspace/ui';
import {
  ArrowUpLeft,
  Copy,
  Download,
  CornerUpRight,
  History,
  LayoutTemplate,
  Link2,
  Lock,
  MoreHorizontal,
  PenLine,
  Trash2,
} from 'lucide-react';
import { useBacklinksMode, type BacklinksMode } from './backlinks';
import { useApp } from './context';
import { HistoryDialog } from './history-dialog';
import { can } from './platform';
import { useState } from 'react';
import type * as Y from 'yjs';

export interface PageMenuProps {
  page: PageMeta;
  /** The page's content doc, for the word count (null while loading). */
  pageDoc: Y.Doc | null;
  onOptions(options: Partial<Pick<PageMeta, 'font' | 'smallText' | 'fullWidth' | 'locked'>>): void;
  onDuplicate(): void;
  /** Omitted where pages can't be moved (database rows). */
  onMove?(): void;
  onCopyLink(): void;
  /** Omitted for database rows. */
  onSaveAsTemplate?(): void;
  /** Omitted for database rows. */
  onExport?(): void;
  onTrash(): void;
  /** Suggest edits: on, and its toggle (null when it's always on: they may only comment). */
  suggest?: { on: boolean; toggle: (() => void) | null };
}

const FONTS: { font: PageFont; label: string; sample: string }[] = [
  { font: 'default', label: 'Default', sample: 'font-sans' },
  { font: 'serif', label: 'Serif', sample: 'font-serif' },
  { font: 'mono', label: 'Mono', sample: 'font-mono' },
];

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative h-3.5 w-6 shrink-0 rounded-full transition-colors',
        on ? 'bg-accent' : 'bg-active',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 size-2.5 rounded-full bg-white transition-all',
          on ? 'left-3' : 'left-0.5',
        )}
      />
    </span>
  );
}

function timeAgo(ms: number, now: number): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** The page's "…" menu: style, lock, duplicate, move, link, trash, and stats. */
export function PageMenu({
  page,
  pageDoc,
  onOptions,
  onDuplicate,
  onMove,
  onCopyLink,
  onSaveAsTemplate,
  onExport,
  onTrash,
  suggest,
}: PageMenuProps) {
  // Computed when the menu opens rather than on every render of the page.
  const [stats, setStats] = useState<{ words: number; now: number } | null>(null);
  const [history, setHistory] = useState(false);
  const [backlinks, setBacklinks] = useBacklinksMode(page.id);
  const { platform } = useApp();

  return (
    <>
      {history && pageDoc && (
        <HistoryDialog docId={page.id} pageDoc={pageDoc} onClose={() => setHistory(false)} />
      )}
      <Menu
        modal={false}
        onOpenChange={(open) =>
          setStats(
            open ? { words: pageDoc ? countWords(pageText(pageDoc)) : 0, now: Date.now() } : null,
          )
        }
      >
        <MenuTrigger asChild>
          <IconButton label="Page options">
            <MoreHorizontal size={18} />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end" className="w-64" aria-label="Page options" data-testid="page-menu">
          <div className="grid grid-cols-3 gap-1 p-1" role="group" aria-label="Font">
            {FONTS.map(({ font, label, sample }) => (
              <button
                key={font}
                type="button"
                aria-pressed={page.font === font}
                onClick={() => onOptions({ font })}
                className={cn(
                  'flex flex-col items-center gap-0.5 rounded-md py-1.5 hover:bg-hover',
                  page.font === font && 'text-accent',
                )}
              >
                <span className={cn('text-xl', sample)}>Ag</span>
                <span className="text-xs text-muted">{label}</span>
              </button>
            ))}
          </div>
          <MenuSeparator />
          <MenuItem
            onSelect={(e) => {
              e.preventDefault();
              onOptions({ smallText: !page.smallText });
            }}
          >
            <span className="flex-1">Small text</span>
            <Toggle on={page.smallText} />
          </MenuItem>
          <MenuItem
            onSelect={(e) => {
              e.preventDefault();
              onOptions({ fullWidth: !page.fullWidth });
            }}
          >
            <span className="flex-1">Full width</span>
            <Toggle on={page.fullWidth} />
          </MenuItem>
          <MenuItem
            icon={<Lock size={14} />}
            onSelect={(e) => {
              e.preventDefault();
              onOptions({ locked: !page.locked });
            }}
          >
            <span className="flex-1">Lock page</span>
            <Toggle on={page.locked} />
          </MenuItem>
          {suggest && (
            <MenuItem
              icon={<PenLine size={14} />}
              disabled={!suggest.toggle}
              onSelect={(e) => {
                e.preventDefault();
                suggest.toggle?.();
              }}
            >
              <span className="flex-1">Suggest edits</span>
              <Toggle on={suggest.on} />
            </MenuItem>
          )}
          {can(platform, 'backlinks') && (
            <MenuSub>
              <MenuSubTrigger icon={<ArrowUpLeft size={14} />}>
                <span className="flex-1">Show backlinks</span>
              </MenuSubTrigger>
              <MenuSubContent>
                <MenuRadioGroup
                  value={backlinks}
                  onValueChange={(mode) => setBacklinks(mode as BacklinksMode)}
                >
                  <MenuRadioItem value="expanded">Expanded</MenuRadioItem>
                  <MenuRadioItem value="popover">As a popover</MenuRadioItem>
                  <MenuRadioItem value="off">Off</MenuRadioItem>
                </MenuRadioGroup>
              </MenuSubContent>
            </MenuSub>
          )}
          {pageDoc && can(platform, 'history') && (
            <MenuItem icon={<History size={14} />} onSelect={() => setHistory(true)}>
              Page history
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<Copy size={14} />} onSelect={onDuplicate}>
            Duplicate
          </MenuItem>
          {onMove && (
            <MenuItem icon={<CornerUpRight size={14} />} onSelect={onMove}>
              Move to
            </MenuItem>
          )}
          <MenuItem icon={<Link2 size={14} />} onSelect={onCopyLink}>
            Copy link
          </MenuItem>
          {onExport && (
            <MenuItem icon={<Download size={14} />} onSelect={onExport}>
              Export…
            </MenuItem>
          )}
          {onSaveAsTemplate && (
            <MenuItem icon={<LayoutTemplate size={14} />} onSelect={onSaveAsTemplate}>
              Save as template
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={14} />} danger onSelect={onTrash}>
            Move to Trash
          </MenuItem>
          {stats && (
            <div className="mt-1 border-t border-line px-2 pt-1.5 pb-1 text-xs text-muted">
              <div data-testid="word-count">Word count: {stats.words.toLocaleString('en-US')}</div>
              <div>Last edited {timeAgo(page.updatedAt, stats.now)}</div>
            </div>
          )}
        </MenuContent>
      </Menu>
    </>
  );
}

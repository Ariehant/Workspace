import { EMOJI, searchEmoji } from '@workspace/editor';
import { cn } from '@workspace/ui';
import { Shuffle } from 'lucide-react';
import { useMemo, useState } from 'react';

const GROUP_LABELS: Record<string, string> = {
  '': 'Smileys',
  'people & body': 'People',
  'animals & nature': 'Animals & nature',
  'food & drink': 'Food & drink',
  'travel & places': 'Travel & places',
  activities: 'Activities',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags',
};

/** Emoji grouped for browsing (skin-tone components are left out). */
const GROUPS = Object.entries(GROUP_LABELS).map(([group, label]) => ({
  label,
  emoji: EMOJI.filter((e) => (e.group ?? '') === group),
}));

export function randomEmoji(): string {
  const pool = GROUPS.slice(0, 7).flatMap((g) => g.emoji);
  return pool[Math.floor(Math.random() * pool.length)]!.emoji!;
}

export interface IconPickerProps {
  hasIcon: boolean;
  onPick(icon: string | null): void;
  onUpload(file: File): Promise<void>;
}

/** Emoji grid with search, random and remove; or upload an image as the icon. */
export function IconPicker({ hasIcon, onPick, onUpload }: IconPickerProps) {
  const [tab, setTab] = useState<'emoji' | 'upload'>('emoji');
  const [query, setQuery] = useState('');
  const results = useMemo(() => (query ? searchEmoji(query) : null), [query]);
  const tabClass = (t: typeof tab) =>
    cn(
      'h-8 border-b-2 px-2 text-sm',
      tab === t ? 'border-fg text-fg' : 'border-transparent text-muted',
    );

  const grid = (items: typeof EMOJI) => (
    <div className="grid grid-cols-10 gap-0.5">
      {items.map((e) => (
        <button
          key={e.name}
          type="button"
          title={`:${e.shortcodes[0]}:`}
          aria-label={e.name.replace(/_/g, ' ')}
          onClick={() => onPick(e.emoji!)}
          className="flex aspect-square w-full items-center justify-center rounded text-xl hover:bg-hover"
        >
          {e.emoji}
        </button>
      ))}
    </div>
  );

  return (
    <div className="w-[384px]" data-testid="icon-picker">
      <div className="flex items-center gap-1 border-b border-line px-2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'emoji'}
          className={tabClass('emoji')}
          onClick={() => setTab('emoji')}
        >
          Emoji
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'upload'}
          className={tabClass('upload')}
          onClick={() => setTab('upload')}
        >
          Upload
        </button>
        <span className="flex-1" />
        {hasIcon && (
          <button
            type="button"
            className="h-7 rounded px-2 text-xs text-muted hover:bg-hover"
            onClick={() => onPick(null)}
          >
            Remove
          </button>
        )}
      </div>
      {tab === 'emoji' ? (
        <div className="p-2">
          <div className="mb-2 flex gap-1">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter…"
              aria-label="Search emoji"
              className="h-8 min-w-0 flex-1 rounded border border-line bg-surface px-2 outline-none focus:border-accent"
            />
            <button
              type="button"
              aria-label="Random emoji"
              title="Random"
              onClick={() => onPick(randomEmoji())}
              className="flex size-8 items-center justify-center rounded border border-line text-muted hover:bg-hover"
            >
              <Shuffle size={15} />
            </button>
          </div>
          <div className="h-72 overflow-x-hidden overflow-y-auto pr-1">
            {results ? (
              results.length ? (
                grid(results)
              ) : (
                <p className="p-2 text-muted">No emoji found</p>
              )
            ) : (
              GROUPS.map((g) => (
                <section key={g.label} className="mb-2">
                  <h3 className="sticky top-0 bg-menu px-1 py-1 text-xs font-medium text-muted">
                    {g.label}
                  </h3>
                  {grid(g.emoji)}
                </section>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="p-3">
          <label className="flex h-9 cursor-pointer items-center justify-center rounded border border-line hover:bg-hover">
            Upload an image
            <input
              type="file"
              accept="image/*"
              aria-label="Upload icon image"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onUpload(file);
              }}
            />
          </label>
          <p className="mt-2 text-xs text-muted">Square images of 280 × 280 pixels work best.</p>
        </div>
      )}
    </div>
  );
}

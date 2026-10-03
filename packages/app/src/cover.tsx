import type { PageCover } from '@workspace/core';
import { Popover, PopoverContent, PopoverTrigger, cn } from '@workspace/ui';
import { useRef, useState, type CSSProperties } from 'react';

/** Gradient covers, by id (ids are what pages store). */
export const GRADIENTS: Record<string, string> = {
  sunset: 'linear-gradient(135deg, #f6d365 0%, #fda085 100%)',
  ocean: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  forest: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  dusk: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
  ember: 'linear-gradient(135deg, #f83600 0%, #f9d423 100%)',
  aurora: 'linear-gradient(135deg, #00c6fb 0%, #005bea 55%, #7f00ff 100%)',
  night: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
  steel: 'linear-gradient(135deg, #485563 0%, #29323c 100%)',
};

/** Solid covers use the palette's text colors (defined for both themes). */
export const COVER_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'brown',
  'gray',
];

export function randomCover(): PageCover {
  const ids = Object.keys(GRADIENTS);
  return { kind: 'gradient', value: ids[Math.floor(Math.random() * ids.length)]!, positionY: 50 };
}

function coverStyle(cover: PageCover, fileUrl: (id: string) => string): CSSProperties {
  if (cover.kind === 'file') {
    return {
      backgroundImage: `url("${fileUrl(cover.value)}")`,
      backgroundSize: 'cover',
      backgroundPosition: `center ${cover.positionY}%`,
    };
  }
  if (cover.kind === 'gradient') return { background: GRADIENTS[cover.value] ?? GRADIENTS.sunset };
  return { background: `var(--ws-${cover.value})` };
}

interface CoverPickerProps {
  onPick(cover: PageCover): void;
  onUpload(file: File): Promise<void>;
}

/** Gallery of colors and gradients, plus image upload. */
function CoverPicker({ onPick, onUpload }: CoverPickerProps) {
  const [tab, setTab] = useState<'gallery' | 'upload'>('gallery');
  const [busy, setBusy] = useState(false);
  const tabClass = (t: typeof tab) =>
    cn(
      'h-8 border-b-2 px-2 text-sm',
      tab === t ? 'border-fg text-fg' : 'border-transparent text-muted',
    );
  const swatch =
    'h-14 rounded-md hover:opacity-85 focus-visible:outline-2 focus-visible:outline-accent';

  return (
    <div className="w-[420px]" data-testid="cover-picker">
      <div className="flex gap-1 border-b border-line px-2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'gallery'}
          className={tabClass('gallery')}
          onClick={() => setTab('gallery')}
        >
          Gallery
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
      </div>
      {tab === 'gallery' ? (
        <div className="max-h-80 space-y-3 overflow-y-auto p-3">
          <section>
            <h3 className="mb-1.5 text-xs font-medium text-muted">Gradients</h3>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(GRADIENTS).map(([id, css]) => (
                <button
                  key={id}
                  type="button"
                  aria-label={`${id} gradient`}
                  className={swatch}
                  style={{ background: css }}
                  onClick={() => onPick({ kind: 'gradient', value: id, positionY: 50 })}
                />
              ))}
            </div>
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-medium text-muted">Colors</h3>
            <div className="grid grid-cols-5 gap-2">
              {COVER_COLORS.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-label={`${name} color`}
                  className={cn(swatch, 'h-10')}
                  style={{ background: `var(--ws-${name})` }}
                  onClick={() => onPick({ kind: 'color', value: name, positionY: 50 })}
                />
              ))}
            </div>
          </section>
        </div>
      ) : (
        <div className="p-3">
          <label className="flex h-9 cursor-pointer items-center justify-center rounded border border-line hover:bg-hover">
            {busy ? 'Uploading…' : 'Upload an image'}
            <input
              type="file"
              accept="image/*"
              aria-label="Upload cover image"
              className="sr-only"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setBusy(true);
                try {
                  await onUpload(file);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
          <p className="mt-2 text-xs text-muted">Images wider than 1500 pixels work best.</p>
        </div>
      )}
    </div>
  );
}

export interface CoverProps {
  cover: PageCover;
  editable: boolean;
  fileUrl(id: string): string;
  onChange(cover: PageCover | null): void;
  onUpload(file: File): Promise<PageCover>;
}

/** The banner above the title, with change / reposition / remove controls on hover. */
export function Cover({ cover, editable, fileUrl, onChange, onUpload }: CoverProps) {
  const [open, setOpen] = useState(false);
  const [repositionY, setRepositionY] = useState<number | null>(null);
  const banner = useRef<HTMLDivElement>(null);
  const shown = repositionY === null ? cover : { ...cover, positionY: repositionY };

  /** Dragging the image up shows more of its bottom, as in Notion. */
  const startDrag = (down: React.PointerEvent) => {
    if (repositionY === null || !banner.current) return;
    down.preventDefault();
    const startY = down.clientY;
    const start = repositionY;
    const height = banner.current.getBoundingClientRect().height;
    const move = (e: PointerEvent) =>
      setRepositionY(
        Math.round(Math.min(100, Math.max(0, start - ((e.clientY - startY) / height) * 100))),
      );
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const control =
    'h-7 rounded bg-surface/90 px-2 text-xs text-muted shadow-sm hover:bg-surface hover:text-fg';
  return (
    <div
      ref={banner}
      role="img"
      aria-label="Page cover"
      data-testid="page-cover"
      data-kind={cover.kind}
      className={cn(
        'group relative h-[30vh] max-h-[280px] min-h-[160px] w-full',
        repositionY !== null && 'cursor-move',
      )}
      style={coverStyle(shown, fileUrl)}
      onPointerDown={startDrag}
    >
      {repositionY !== null && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded bg-black/50 px-3 py-1.5 text-xs text-white">
            Drag image to reposition
          </span>
        </div>
      )}
      {editable && (
        <div
          className={cn(
            'absolute right-[max(16px,calc((100%-900px)/2+96px))] bottom-3 flex gap-1 transition-opacity',
            repositionY === null && !open && 'opacity-0 group-hover:opacity-100',
          )}
        >
          {repositionY !== null ? (
            <>
              <button
                type="button"
                className={control}
                onClick={() => {
                  onChange({ ...cover, positionY: repositionY });
                  setRepositionY(null);
                }}
              >
                Save position
              </button>
              <button type="button" className={control} onClick={() => setRepositionY(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                  <button type="button" className={control}>
                    Change cover
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end">
                  <CoverPicker
                    onPick={(next) => {
                      onChange(next);
                      setOpen(false);
                    }}
                    onUpload={async (file) => {
                      onChange(await onUpload(file));
                      setOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
              {cover.kind === 'file' && (
                <button
                  type="button"
                  className={control}
                  onClick={() => setRepositionY(cover.positionY)}
                >
                  Reposition
                </button>
              )}
              <button type="button" className={control} onClick={() => onChange(null)}>
                Remove
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

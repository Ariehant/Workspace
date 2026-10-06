import type { PageId } from '@workspace/core';
import { renderMermaid } from '@workspace/editor';
import { Button, Dialog, DialogContent, cn } from '@workspace/ui';
import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from './context';
import type { ExportFormat, ExportStatus, Platform } from './platform';

const FORMATS: { id: ExportFormat; label: string; hint: string; pageOnly?: boolean }[] = [
  {
    id: 'markdown',
    label: 'Markdown & CSV',
    hint: 'Pages as .md, databases as .csv, in Notion’s layout (a .zip).',
  },
  { id: 'html', label: 'HTML', hint: 'Pages as standalone web pages with their files (a .zip).' },
  { id: 'pdf', label: 'PDF', hint: 'The page as it looks, ready to print.', pageOnly: true },
];

/** Export a page (with its sub-pages) or the whole workspace. */
export function ExportDialog({ pageId, onClose }: { pageId: PageId | null; onClose(): void }) {
  const { platform } = useApp();
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [subpages, setSubpages] = useState(true);
  const [pageSize, setPageSize] = useState<'A4' | 'Letter'>('A4');
  const [scale, setScale] = useState(100);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    try {
      const started = await platform.startExport({
        format,
        ...(pageId ? { pageId, includeSubpages: subpages } : {}),
        ...(format === 'pdf' ? { pdf: { pageSize, scale: scale / 100 } } : {}),
      });
      if (started) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^.*Error: /, '') : String(e));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={pageId ? 'Export page' : 'Export all workspace content'}
        className="w-[min(440px,calc(100vw-32px))]"
        data-testid="export-dialog"
      >
        <div className="flex flex-col gap-4 p-4 pt-2 text-sm">
          <div role="radiogroup" aria-label="Export format" className="flex flex-col gap-1">
            {FORMATS.filter((f) => pageId || !f.pageOnly).map((f) => (
              <label
                key={f.id}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md border border-line p-2 hover:bg-hover',
                  format === f.id && 'border-accent',
                )}
              >
                <input
                  type="radio"
                  name="export-format"
                  value={f.id}
                  checked={format === f.id}
                  onChange={() => setFormat(f.id)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium">{f.label}</span>
                  <span className="block text-xs text-muted">{f.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {pageId && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={subpages}
                onChange={(event) => setSubpages(event.target.checked)}
              />
              Include sub-pages
            </label>
          )}
          {format === 'pdf' && (
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                Page size
                <select
                  value={pageSize}
                  onChange={(event) => setPageSize(event.target.value as 'A4' | 'Letter')}
                  className="rounded border border-line bg-surface px-1 py-0.5"
                >
                  <option value="A4">A4</option>
                  <option value="Letter">Letter</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                Scale
                <select
                  value={scale}
                  onChange={(event) => setScale(Number(event.target.value))}
                  className="rounded border border-line bg-surface px-1 py-0.5"
                >
                  {[50, 75, 90, 100, 110, 125, 150].map((s) => (
                    <option key={s} value={s}>
                      {s}%
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {error && (
            <p className="text-danger" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void start()}>
              Export
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Answer exports' requests to draw Mermaid diagrams (the worker has no DOM). */
export function useDiagramProvider(platform: Platform): void {
  useEffect(
    () =>
      platform.provideDiagrams(async (sources) => {
        const svgs: Record<string, string> = {};
        for (const source of sources) {
          const result = await renderMermaid(source, false);
          if (result.svg) svgs[source] = result.svg;
        }
        return svgs;
      }),
    [platform],
  );
}

/** How the current export is going: progress and Cancel, then where it was saved. */
export function ExportProgress() {
  const { platform } = useApp();
  const [status, setStatus] = useState<ExportStatus | null>(null);
  useEffect(() => platform.onExportStatus(setStatus), [platform]);
  useEffect(() => {
    if (status?.state !== 'cancelled') return;
    const timer = setTimeout(() => setStatus(null), 1500);
    return () => clearTimeout(timer);
  }, [status]);
  if (!status) return null;

  const percent =
    status.state === 'running' && status.total > 0
      ? Math.round((status.done / status.total) * 100)
      : null;
  return (
    <div
      role="status"
      data-testid="export-status"
      data-state={status.state}
      className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2 rounded-lg bg-menu p-3 text-sm text-fg shadow-menu"
    >
      <div className="flex items-center gap-2">
        {status.state === 'running' && <Loader2 size={14} className="animate-spin" />}
        {status.state === 'done' && <Check size={14} className="text-accent" />}
        <span className="flex-1 font-medium">
          {status.state === 'running'
            ? `Exporting…${percent !== null ? ` ${percent}%` : ''}`
            : status.state === 'done'
              ? 'Export saved'
              : status.state === 'cancelled'
                ? 'Export cancelled'
                : 'Export failed'}
        </span>
        {status.state === 'running' ? (
          <button
            type="button"
            onClick={() => platform.cancelExport()}
            className="rounded px-2 py-0.5 text-xs hover:bg-hover"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setStatus(null)}
            className="rounded p-0.5 hover:bg-hover"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {status.state === 'running' && (
        <div className="h-1 overflow-hidden rounded bg-active">
          <div
            className="h-full bg-accent transition-[width]"
            style={{ width: `${percent ?? 5}%` }}
          />
        </div>
      )}
      {status.state === 'done' && (
        <p className="truncate text-xs text-muted" title={status.path} data-testid="export-path">
          {status.path}
        </p>
      )}
      {status.state === 'failed' && <p className="text-xs text-danger">{status.error}</p>}
    </div>
  );
}

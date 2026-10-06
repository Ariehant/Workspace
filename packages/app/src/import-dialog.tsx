import { Button, Dialog, DialogContent } from '@workspace/ui';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from './context';
import type { ImportReport, ImportStatus } from './platform';

/** How an import is going, then what it brought in (and what it couldn't). */
export function ImportProgress({ onOpen }: { onOpen(pageId: string): void }) {
  const { platform } = useApp();
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  useEffect(
    () =>
      platform.onImportStatus((next) => {
        if (next.state === 'done') {
          setStatus(null);
          setReport(next.report);
          onOpen(next.report.rootId);
        } else setStatus(next);
      }),
    [platform, onOpen],
  );
  useEffect(() => {
    if (status?.state !== 'cancelled') return;
    const timer = setTimeout(() => setStatus(null), 1500);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <>
      {status && (
        <div
          role="status"
          data-testid="import-status"
          data-state={status.state}
          className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2 rounded-lg bg-menu p-3 text-sm text-fg shadow-menu"
        >
          <div className="flex items-center gap-2">
            {status.state === 'running' && <Loader2 size={14} className="animate-spin" />}
            <span className="flex-1 font-medium">
              {status.state === 'running'
                ? `Importing…${status.total ? ` ${Math.round((status.done / status.total) * 100)}%` : ''}`
                : status.state === 'cancelled'
                  ? 'Import cancelled'
                  : 'Import failed'}
            </span>
            {status.state === 'running' ? (
              <button
                type="button"
                onClick={() => platform.cancelImport()}
                className="rounded px-2 py-0.5 text-xs hover:bg-hover"
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStatus(null)}
                className="rounded px-2 py-0.5 text-xs hover:bg-hover"
              >
                Dismiss
              </button>
            )}
          </div>
          {status.state === 'failed' && <p className="text-xs text-danger">{status.error}</p>}
        </div>
      )}
      {report && (
        <Dialog open onOpenChange={(open) => !open && setReport(null)}>
          <DialogContent
            title="Import finished"
            className="w-[min(480px,calc(100vw-32px))]"
            data-testid="import-report"
          >
            <div className="flex flex-col gap-3 p-4 pt-2 text-sm">
              <p data-testid="import-counts">
                {plural(report.pages, 'page')}, {plural(report.databases, 'database')} with{' '}
                {plural(report.rows, 'row')}, and {plural(report.files, 'file')}.
              </p>
              {report.warnings.length > 0 ? (
                <div>
                  <p className="mb-1 font-medium">Not imported exactly:</p>
                  <ul
                    className="max-h-48 list-disc overflow-y-auto pl-5 break-words text-muted"
                    data-testid="import-warnings"
                  >
                    {report.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-muted">Everything came over.</p>
              )}
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => setReport(null)}>
                  Done
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

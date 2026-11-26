/**
 * Subscribing to a calendar by its address (HANDOFF.md 5): an iCalendar feed (`.ics`,
 * `webcal://`), such as public holidays, a team's schedule, or another app's published
 * calendar. Read-only; refreshed every 30 minutes.
 */
import { Button, Dialog, DialogContent } from '@workspace/ui';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, unwrap } from './api';

const inputClass =
  'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-fg outline-none focus:border-accent';

export function SubscribeDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.ics.subscribe(url, name.trim() || undefined));
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Subscribe to a calendar"
        className="top-[8vh] w-[min(520px,calc(100vw-32px))]"
      >
        <form onSubmit={submit} className="flex flex-col gap-3 px-4 pt-2 pb-4">
          <p className="text-sm text-muted">
            Paste the address of a calendar feed (an <code>.ics</code> or <code>webcal://</code>{' '}
            link), such as public holidays or a calendar another app publishes. It&apos;s shown
            read-only, and checked for changes every 30 minutes.
          </p>
          {error && (
            <p role="alert" className="flex gap-1.5 rounded-md bg-hover p-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Calendar address</span>
            <input
              className={inputClass}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/holidays.ics"
              spellCheck={false}
              autoFocus
              required
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Name (optional)</span>
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="The feed's own name"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy || !url.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Subscribe
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

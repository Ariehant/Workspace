/**
 * Share link (Phase 8 N8, #34), in the Share dialog: a link for this page that anyone can
 * use after signing in (they join the workspace as a guest, with the link's role on this
 * page alone). Off until made; a new one ends the old.
 */
import { formatShortDay, type PageId } from '@workspace/core';
import { Button } from '@workspace/ui';
import { Check, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ShareLinkInfo, ShareLinkRole, TeamApi } from './team';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const select =
  'h-8 rounded-md border border-line bg-surface px-2 text-sm outline-none focus:border-accent';

const ROLE_LABELS: Record<ShareLinkRole, string> = {
  view: 'Can view',
  comment: 'Can comment',
  edit: 'Can edit',
};
const DURATIONS: [string, number | null][] = [
  ['Never ends', null],
  ['Ends in 1 day', 1],
  ['Ends in 7 days', 7],
  ['Ends in 30 days', 30],
];

export function ShareLinkSection({
  team,
  pageId,
  onChanged,
}: {
  team: TeamApi;
  pageId: PageId;
  /** A link was made: the page is now shared on its own (its scope changed). */
  onChanged(): void;
}) {
  const [link, setLink] = useState<ShareLinkInfo | null | undefined>(undefined);
  const [role, setRole] = useState<ShareLinkRole>('view');
  const [days, setDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    team.shareLink(pageId).then(
      (r) => {
        setLink(r.link);
        if (r.link) setRole(r.link.role);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [team, pageId]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };
  const make = () =>
    run(async () => {
      setLink((await team.makeShareLink(pageId, role, days)).link);
      onChanged();
    });
  const turnOff = () =>
    run(async () => {
      await team.removeShareLink(pageId);
      setLink(null);
    });

  if (link === undefined) return error ? <p className="text-sm text-danger">{error}</p> : null;
  return (
    <section
      aria-label="Share link"
      data-testid="share-link"
      className="flex flex-col gap-2 border-t border-line pt-3 text-sm"
    >
      <h3 className="flex items-center gap-1.5 font-medium">
        <Link2 size={14} aria-hidden /> Share link
      </h3>
      <p className="text-xs text-muted">
        Anyone with the link who signs in gets this page alone, as a guest.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Anyone with the link can"
          className={select}
          value={role}
          onChange={(e) => setRole(e.target.value as ShareLinkRole)}
        >
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Link ends"
          className={select}
          value={days ?? ''}
          onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}
        >
          {DURATIONS.map(([label, value]) => (
            <option key={label} value={value ?? ''}>
              {label}
            </option>
          ))}
        </select>
        <Button variant="primary" disabled={busy} onClick={() => void make()}>
          {link ? 'New link' : 'Make a link'}
        </Button>
      </div>
      {link && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <input
              readOnly
              aria-label="Share link address"
              value={link.url}
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(link.url);
                setCopied(true);
              }}
            >
              {copied ? <Check size={14} /> : null}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button disabled={busy} onClick={() => void turnOff()}>
              Turn off
            </Button>
          </div>
          <p className="text-xs text-muted" data-testid="share-link-summary">
            {ROLE_LABELS[link.role]}
            {link.expiresAt
              ? ` · ends ${formatShortDay(new Date(link.expiresAt))}`
              : ' · until turned off'}
            . A new link ends this one; people who joined keep their access.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

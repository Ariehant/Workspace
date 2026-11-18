/**
 * A page that can't be shown (Phase 8 N4): a link or mention to a page this person can't
 * open, or one that's gone. In a server workspace they can ask for access, as in Notion; the
 * people who can share the page are told, and once it's shared it opens here.
 */
import { formatShortDay, type PageId } from '@workspace/core';
import { Button } from '@workspace/ui';
import { Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from './context';
import {
  REQUESTED_ROLES,
  SCOPE_ROLE_LABELS,
  type OwnAccessRequest,
  type PageAccess,
  type RequestedRole,
} from './team';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** When to look again for a page the server doesn't know (yet). */
const RECHECK_MS = [1000, 2500, 5000];

export function NoAccess({
  pageId,
  version,
  onFound,
}: {
  pageId: PageId;
  /** Changes as the workspace does: the page may have been shared meanwhile. */
  version: number;
  /** The page can be opened now. */
  onFound(): void;
}) {
  const { team } = useApp();
  const [asked, setAccess] = useState<PageAccess | null>(null);
  // Without a server there's no one to ask: a page that isn't here is gone.
  const access: PageAccess | null = team ? asked : { exists: false };
  const [role, setRole] = useState<RequestedRole>('view');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!team) return;
    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const check = (retry: number) =>
      team.pageAccess(pageId).then(
        (result) => {
          if (!active) return;
          setAccess(result);
          if (result.exists && result.readable) onFound();
          // A page made a moment ago may not be in the server's index yet: look again.
          else if (!result.exists && retry < RECHECK_MS.length) {
            timers.push(setTimeout(() => void check(retry + 1), RECHECK_MS[retry]));
          }
        },
        (e: unknown) => active && setError(errorText(e)),
      );
    void check(0);
    return () => {
      active = false;
      timers.forEach(clearTimeout);
    };
    // `version`: ask again as the workspace changes (a share arrives by sync).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, pageId, version]);

  const ask = async () => {
    if (!team) return;
    setBusy(true);
    setError(null);
    try {
      const { request } = await team.requestAccess(pageId, role, message.trim());
      setAccess({ exists: true, readable: false, request });
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const request: OwnAccessRequest | null =
    access?.exists && !access.readable ? access.request : null;
  return (
    <main
      className="flex flex-1 items-center justify-center bg-surface p-8"
      data-testid="no-access"
    >
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <Lock size={28} className="text-faint" aria-hidden />
        {access === null && !error && <p className="text-muted">Checking…</p>}
        {access && !access.exists && (
          <>
            <h1 className="text-lg font-semibold">This page doesn’t exist</h1>
            <p className="text-sm text-muted">It may have been deleted, or the link is wrong.</p>
          </>
        )}
        {access?.exists && access.readable && <p className="text-muted">Opening…</p>}
        {access?.exists && !access.readable && (
          <>
            <h1 className="text-lg font-semibold">You don’t have access to this page</h1>
            {request?.status === 'pending' ? (
              <p className="text-sm text-muted" data-testid="access-requested" role="status">
                Access requested on {formatShortDay(new Date(request.createdAt))}. It opens here
                once it’s shared with you.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted">
                  {request?.status === 'declined'
                    ? 'Your last request was declined. You can ask again.'
                    : 'Ask the people who can share it. They’ll get your request in their inbox.'}
                </p>
                <form
                  className="flex w-full flex-col gap-2 text-left text-sm"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void ask();
                  }}
                >
                  <label className="flex flex-col gap-1">
                    <span className="text-muted">Access to ask for</span>
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value as RequestedRole)}
                      className="h-8 rounded border border-line bg-surface px-2"
                    >
                      {REQUESTED_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {SCOPE_ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted">Message (optional)</span>
                    <textarea
                      value={message}
                      maxLength={500}
                      rows={3}
                      onChange={(e) => setMessage(e.target.value)}
                      className="rounded border border-line bg-surface p-2"
                    />
                  </label>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={busy}
                    data-testid="request-access"
                    className="self-center"
                  >
                    Request access
                  </Button>
                </form>
              </>
            )}
          </>
        )}
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

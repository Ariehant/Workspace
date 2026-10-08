/**
 * Publish to the web (Phase 5 M7), in the Share dialog: a page (and its sub-pages) at a
 * public address anyone can read, with an address of its own, whether search engines
 * may index it, and a title and description for search results and link previews.
 */
import type { PageId } from '@workspace/core';
import { Button } from '@workspace/ui';
import { Check, Globe, Link } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PublishSettings, PublishedPage, TeamApi } from './team';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const input =
  'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm outline-none focus:border-accent';

export function PublishSection({
  team,
  pageId,
  canPublish,
}: {
  team: TeamApi;
  pageId: PageId;
  /** Full access: may publish, change and unpublish (others see whether it's published). */
  canPublish: boolean;
}) {
  const [published, setPublished] = useState<PublishedPage | null | undefined>(undefined);
  const [draft, setDraft] = useState<PublishSettings | null>(null);
  const [suggested, setSuggested] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    team.published(pageId).then(
      (r) => {
        setPublished(r.published);
        setSuggested(r.suggestedSlug);
        setDraft(r.published ? settingsOf(r.published) : null);
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, [team, pageId]);

  const save = async (settings: PublishSettings) => {
    setBusy(true);
    setError(null);
    try {
      const r = await team.publish(pageId, settings);
      setPublished(r.published);
      setDraft(settingsOf(r.published));
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const unpublish = async () => {
    setBusy(true);
    setError(null);
    try {
      await team.unpublish(pageId);
      setPublished(null);
      setDraft(null);
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  if (published === undefined) return null;
  return (
    <section
      className="flex flex-col gap-2 border-t border-line pt-3"
      data-testid="publish-section"
      aria-label="Publish to web"
    >
      <div className="flex items-center gap-2">
        <Globe size={16} className={published ? 'text-accent' : 'text-muted'} />
        <span className="flex-1 text-sm font-medium">
          {published ? 'Published to the web' : 'Publish to web'}
        </span>
        {!published && canPublish && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void save({
                slug: suggested,
                includeSubpages: true,
                allowIndexing: false,
                title: '',
                description: '',
              })
            }
          >
            Publish
          </Button>
        )}
      </div>
      {!published && (
        <p className="text-xs text-muted">
          {canPublish
            ? 'Anyone with the link can read it (and its sub-pages), without signing in.'
            : 'Only people with full access can publish this page.'}
        </p>
      )}
      {published && (
        <>
          <div className="flex items-center gap-2">
            <a
              href={published.url}
              target="_blank"
              rel="noreferrer"
              data-testid="publish-url"
              className="min-w-0 flex-1 truncate text-sm text-accent hover:underline"
            >
              {published.url}
            </a>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(published.url);
                setCopied(true);
              }}
            >
              {copied ? <Check size={14} /> : <Link size={14} />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {canPublish && draft && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save(draft);
              }}
            >
              <label className="flex flex-col gap-1 text-xs text-muted">
                Address
                <span className="flex items-center gap-1 text-sm text-fg">
                  <span className="text-muted">/p/</span>
                  <input
                    aria-label="Address"
                    value={draft.slug}
                    onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
                    className={input}
                  />
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.includeSubpages}
                  onChange={(e) => setDraft({ ...draft, includeSubpages: e.target.checked })}
                />
                Include sub-pages
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.allowIndexing}
                  onChange={(e) => setDraft({ ...draft, allowIndexing: e.target.checked })}
                />
                Search engines may index it
              </label>
              <input
                aria-label="Title for search results"
                placeholder="Title for search results and link previews"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                className={input}
              />
              <input
                aria-label="Description"
                placeholder="Description"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                className={input}
              />
              <div className="flex justify-end gap-2">
                <Button disabled={busy} onClick={() => void unpublish()}>
                  Unpublish
                </Button>
                <Button type="submit" variant="primary" disabled={busy}>
                  Save
                </Button>
              </div>
            </form>
          )}
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

const settingsOf = (p: PublishedPage): PublishSettings => ({
  slug: p.slug,
  includeSubpages: p.includeSubpages,
  allowIndexing: p.allowIndexing,
  title: p.title,
  description: p.description,
});

/**
 * Settings → Integrations (Phase 6 M5, owners and admins): internal integrations that
 * use the API. Each has a token (shown once, when it's made or replaced), what it may
 * do, and sees only the pages connected to it (a page's Share → Connections).
 */
import { Button, IconButton } from '@workspace/ui';
import { Check, Copy, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { IntegrationCapabilities, IntegrationInfo, TeamApi } from './team';

const input =
  'h-8 rounded-md border border-line bg-transparent px-2 text-sm text-fg outline-none placeholder:text-faint focus:border-accent';
const select =
  'h-7 rounded-md border border-line bg-surface px-1.5 text-sm text-fg outline-none focus:border-accent';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const CONTENT: [keyof IntegrationCapabilities, string][] = [
  ['readContent', 'Read content'],
  ['updateContent', 'Update content'],
  ['insertContent', 'Insert content'],
  ['readComments', 'Read comments'],
  ['insertComments', 'Insert comments'],
];

/** A token, shown once, with a copy button. */
function TokenOnce({ token, onDone }: { token: string; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-accent/40 bg-accent/5 p-3"
      data-testid="integration-token"
    >
      <p className="text-sm">
        Copy this token now: it isn’t shown again. Send it as{' '}
        <code className="text-xs">Authorization: Bearer …</code>.
      </p>
      <div className="flex gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded bg-hover px-2 py-1 text-xs"
          data-testid="integration-token-value"
        >
          {token}
        </code>
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(token);
            setCopied(true);
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

export function IntegrationsPanel({ team }: { team: TeamApi }) {
  const [list, setList] = useState<IntegrationInfo[] | null>(null);
  const [name, setName] = useState('');
  const [token, setToken] = useState<{ id: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      team.integrations().then(
        (r) => setList(r.integrations),
        (e: unknown) => setError(errorText(e)),
      ),
    [team],
  );
  useEffect(() => void reload(), [reload]);

  const act = async (change: () => Promise<unknown>) => {
    setError(null);
    try {
      await change();
    } catch (e) {
      setError(errorText(e));
    }
    await reload();
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void act(async () => {
      const made = await team.createIntegration({ name: trimmed, icon: '🤖' });
      setToken({ id: made.integration.id, token: made.token });
      setName('');
    });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="integrations-panel">
      <p className="text-sm text-muted">
        Integrations use the API (Notion’s, at <code className="text-xs">/v1</code>) with a token.
        They see only the pages connected to them: Share → Connections on a page.
      </p>
      <form className="flex gap-2" onSubmit={create}>
        <input
          aria-label="Integration name"
          placeholder="New integration name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`${input} min-w-0 flex-1`}
        />
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Create
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {list === null && !error && <Loader2 className="animate-spin text-muted" />}
      {list?.length === 0 && <p className="text-sm text-faint">No integrations yet.</p>}
      <ul className="flex flex-col gap-2">
        {list?.map((i) => (
          <li
            key={i.id}
            className="flex flex-col gap-2 rounded-md border border-line p-3"
            data-testid="integration-row"
          >
            <div className="flex items-center gap-2">
              <span aria-hidden>{i.icon ?? '🤖'}</span>
              <span className="flex-1 font-medium">{i.name}</span>
              <span className="text-xs text-faint">
                {i.tokenHint ? `ntn_…${i.tokenHint}` : ''}
                {i.lastUsedAt ? ` · used ${new Date(i.lastUsedAt).toLocaleDateString()}` : ''}
              </span>
              <IconButton
                label={`New token for ${i.name}`}
                size="sm"
                onClick={() => {
                  if (
                    !window.confirm(`Replace ${i.name}’s token? The old one stops working at once.`)
                  )
                    return;
                  void act(async () => {
                    const r = await team.rotateIntegrationToken(i.id);
                    setToken({ id: i.id, token: r.token });
                  });
                }}
              >
                <KeyRound size={14} />
              </IconButton>
              <IconButton
                label={`Delete ${i.name}`}
                size="sm"
                onClick={() => {
                  if (
                    !window.confirm(
                      `Delete ${i.name}? Its token stops working, and it loses every page connected to it.`,
                    )
                  )
                    return;
                  void act(() => team.deleteIntegration(i.id));
                }}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
            {token?.id === i.id && <TokenOnce token={token.token} onDone={() => setToken(null)} />}
            {i.capabilities && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                {CONTENT.map(([key, label]) => (
                  <label key={key} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={i.capabilities![key] === true}
                      onChange={(e) =>
                        void act(() =>
                          team.updateIntegration(i.id, {
                            capabilities: { [key]: e.target.checked },
                          }),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
                <label className="flex items-center gap-1.5">
                  People
                  <select
                    aria-label={`${i.name}: user information`}
                    value={i.capabilities.userInfo}
                    onChange={(e) =>
                      void act(() =>
                        team.updateIntegration(i.id, {
                          capabilities: {
                            userInfo: e.target.value as IntegrationCapabilities['userInfo'],
                          },
                        }),
                      )
                    }
                    className={select}
                  >
                    <option value="none">No user information</option>
                    <option value="noEmail">Without email addresses</option>
                    <option value="email">With email addresses</option>
                  </select>
                </label>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

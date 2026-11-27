/**
 * The online check in the app (see `online-check.ts`): the page header's "2 online · 1
 * offline" with its list and **Ping**, the toast for a manual ping from someone else, and
 * the hook that runs the checks for a shared page.
 */
import { getPage, type PageId } from '@workspace/core';
import { Avatar, Button, cn, Popover, PopoverContent, PopoverTrigger } from '@workspace/ui';
import { BellRing, X } from 'lucide-react';
import { useEffect, useMemo, useReducer, useState, useSyncExternalStore } from 'react';
import { useApp } from './context';
import { useDocVersion } from './hooks';
import type { OnlineCheckPlatform } from './platform';
import {
  ANSWER_WAIT_MS,
  CheckRounds,
  CheckSchedule,
  onlineSummary,
  splitOnline,
  type Person,
} from './online-check';

// --- Sharing changed -----------------------------------------------------------------------

const sharedListeners = new Set<(pageId: PageId) => void>();

/** Someone was invited to a page, or its access changed: check who's there again. */
export function notifyShared(pageId: PageId): void {
  for (const listener of sharedListeners) listener(pageId);
}

// --- The page's check, for the Share dialog -------------------------------------------------

const published = new Map<PageId, OnlineCheck>();
const publishedListeners = new Set<() => void>();

const signature = (c: OnlineCheck) =>
  JSON.stringify([
    c.online.map((p) => p.id),
    c.offline.map((p) => p.id),
    c.checking,
    c.auto,
    c.problem,
    c.lastAskedAt,
  ]);

function publish(pageId: PageId, check: OnlineCheck | null): void {
  const before = published.get(pageId);
  if (check) {
    published.set(pageId, check);
    if (before && signature(before) === signature(check)) return;
  } else if (!published.delete(pageId)) return;
  for (const listener of publishedListeners) listener();
}

/** The online check the open page runs (null if it runs none). */
export function usePublishedCheck(pageId: PageId): OnlineCheck | null {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    publishedListeners.add(rerender);
    return () => void publishedListeners.delete(rerender);
  }, []);
  return published.get(pageId) ?? null;
}

// --- The hook ------------------------------------------------------------------------------

export interface OnlineCheck {
  online: Person[];
  offline: Person[];
  /** Answers to the latest check may still come in. */
  checking: boolean;
  /** Checking every 20 s (for 5 minutes after sharing or opening the page). */
  auto: boolean;
  /** Why it can't check now: not connected to the server, or asked too often (for so long). */
  problem: { kind: 'offline' } | { kind: 'limited'; seconds: number } | null;
  lastAskedAt: number | null;
  /** Ask now, by hand: the people asked see who's asking. */
  ping(): void;
}

interface CheckState {
  people: Person[] | null;
  online: ReadonlySet<string>;
  checking: boolean;
  auto: boolean;
  problem: OnlineCheck['problem'];
  lastAskedAt: number | null;
}

const NO_CHECK: CheckState = {
  people: null,
  online: new Set(),
  checking: false,
  auto: false,
  problem: null,
  lastAskedAt: null,
};

/** One page's checks: who has access, the schedule, and the answers (a small store). */
class PageCheck {
  private readonly rounds = new CheckRounds();
  private readonly schedule = new CheckSchedule(() => void this.ask(false));
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly stopAcks: () => void;
  private people: Person[] | null = null;
  private problem: OnlineCheck['problem'] = null;
  private state: CheckState = NO_CHECK;

  constructor(
    private readonly check: OnlineCheckPlatform,
    private readonly pageId: PageId,
    private readonly me: string,
  ) {
    this.stopAcks = check.onAcked((nonce, userId) => {
      if (this.rounds.answered(nonce, userId)) this.emit();
    });
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readonly getState = () => this.state;

  /** Who has access (null: nothing to check). Someone else there starts the checks. */
  setPeople(people: Person[] | null): void {
    const had = this.others;
    this.people = people;
    if (!this.others) this.schedule.stop();
    else if (!had) this.schedule.start();
    this.emit();
  }

  /** Sharing changed: 5 more minutes of checks. */
  restart(): void {
    if (this.others) this.schedule.start();
    this.emit();
  }

  async ask(manual: boolean): Promise<void> {
    const result = await this.check.ping(this.pageId, manual);
    if ('nonce' in result) {
      this.rounds.asked(result.nonce, Date.now());
      this.problem = null;
      // Once the answers are in: whoever didn't answer is offline.
      this.later(() => this.emit(), ANSWER_WAIT_MS + 50);
    } else if (result.error === 'offline') {
      this.problem = { kind: 'offline' };
    } else if (manual) {
      this.problem = { kind: 'limited', seconds: Math.max(1, Math.ceil(result.retryInMs / 1000)) };
      this.later(() => {
        this.problem = null;
        this.emit();
      }, result.retryInMs);
    }
    this.emit();
  }

  dispose(): void {
    this.schedule.stop();
    this.stopAcks();
    for (const timer of this.timers) clearTimeout(timer);
    this.listeners.clear();
  }

  private get others(): boolean {
    return !!this.people?.some((p) => p.id !== this.me);
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private emit(): void {
    const now = Date.now();
    this.state = {
      people: this.people,
      online: this.rounds.online(now),
      checking: this.rounds.waiting(now),
      auto: this.schedule.running,
      problem: this.problem,
      lastAskedAt: this.rounds.lastAskedAt,
    };
    for (const listener of this.listeners) listener();
  }
}

const noSubscribe = () => () => {};
const noState = () => NO_CHECK;

/**
 * Who of the people with access to a shared page is there. Null where there's nothing to
 * check: a host without a server, a page that isn't shared, or no one else with access.
 * `present`: the people on the page now (their presence), online whatever the checks say.
 */
export function useOnlineCheck(pageId: PageId, present: readonly string[]): OnlineCheck | null {
  const { platform, team, workspace, user } = useApp();
  const check = platform.onlineCheck;
  useDocVersion(workspace);
  const info = workspace.treeOf(pageId)?.info;
  const scopeId = info?.kind === 'shared' ? info.scope : null;

  const store = useMemo(
    () => (check ? new PageCheck(check, pageId, user.id) : null),
    [check, pageId, user.id],
  );
  useEffect(() => () => store?.dispose(), [store]);
  const state = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getState ?? noState);

  // Who has access, again whenever sharing changes (which also starts the checks over).
  const [shared, bumpShared] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listener = (id: PageId) => {
      if (id !== pageId) return;
      bumpShared();
      store?.restart();
    };
    sharedListeners.add(listener);
    return () => void sharedListeners.delete(listener);
  }, [pageId, store]);
  useEffect(() => {
    if (!store) return;
    if (!team || !scopeId) {
      store.setPeople(null);
      return;
    }
    let alive = true;
    team.scopePeople(scopeId).then(
      (r) => alive && store.setPeople(r.people),
      () => alive && store.setPeople(null),
    );
    return () => {
      alive = false;
    };
  }, [store, team, scopeId, shared]);

  let result: OnlineCheck | null = null;
  if (store && state.people?.some((p) => p.id !== user.id)) {
    const online = new Set([...state.online, ...present]);
    result = {
      ...splitOnline(state.people, user.id, online),
      checking: state.checking,
      auto: state.auto,
      problem: state.problem,
      lastAskedAt: state.lastAskedAt,
      ping: () => void store.ask(true),
    };
  }
  // The Share dialog shows the same.
  useEffect(() => publish(pageId, result));
  useEffect(() => () => publish(pageId, null), [pageId]);
  return result;
}

// --- The header's indicator ------------------------------------------------------------------

/** "Asked at 14:05". */
const askedAt = (at: number | null): string =>
  at === null
    ? 'Not asked yet'
    : `Asked at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

export function OnlineIndicator({ check }: { check: OnlineCheck }) {
  const { online, offline, problem } = check;
  const status =
    problem?.kind === 'offline'
      ? 'This computer isn’t connected to the server, so it can’t check now.'
      : problem?.kind === 'limited'
        ? `Asked a moment ago: try again in ${problem.seconds} s.`
        : check.checking
          ? 'Checking…'
          : check.auto
            ? `${askedAt(check.lastAskedAt)} · checking every 20 s`
            : askedAt(check.lastAskedAt);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="online-indicator"
          className="flex h-7 items-center gap-1.5 rounded px-2 text-xs text-muted hover:bg-hover"
          title="Who of the people with access is online"
        >
          <span
            aria-hidden
            className={cn(
              'size-2 rounded-full',
              problem?.kind === 'offline'
                ? 'bg-faint'
                : online.length > 0
                  ? 'bg-green-500'
                  : 'bg-line',
            )}
          />
          {onlineSummary(online.length, offline.length)}
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label="Who’s online" align="end" className="w-72 p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex-1 text-xs text-muted" role="status" data-testid="online-status">
            {status}
          </span>
          <Button
            data-testid="online-ping"
            disabled={problem !== null && problem.kind === 'limited'}
            onClick={check.ping}
            title="Ask everyone with access whether they’re here (they see that you asked)"
          >
            <BellRing size={14} /> Ping
          </Button>
        </div>
        <PeopleList title="Online" people={online} online />
        <PeopleList title="Offline" people={offline} online={false} />
      </PopoverContent>
    </Popover>
  );
}

/** The same list, in the Share dialog. */
export function OnlinePeople({ check }: { check: OnlineCheck }) {
  return (
    <section aria-label="Who’s online" data-testid="share-online" className="text-sm">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="flex-1 text-xs font-medium text-muted">
          {onlineSummary(check.online.length, check.offline.length)}
        </h3>
        <Button data-testid="share-online-ping" onClick={check.ping}>
          <BellRing size={14} /> Ping
        </Button>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {[...check.online, ...check.offline].map((p) => {
          const on = check.online.includes(p);
          return (
            <li
              key={p.id}
              title={`${p.name} · ${on ? 'online' : 'offline'}`}
              className={cn('flex items-center gap-1', !on && 'opacity-50')}
            >
              <Avatar id={p.id} name={p.name} src={p.avatar} size={20} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PeopleList({
  title,
  people,
  online,
}: {
  title: string;
  people: Person[];
  online: boolean;
}) {
  if (people.length === 0) return null;
  return (
    <div className="mt-1">
      <div className="py-1 text-xs font-medium text-muted">
        {title} · {people.length}
      </div>
      <ul data-testid={online ? 'online-list' : 'offline-list'}>
        {people.map((p) => (
          <li
            key={p.id}
            data-testid="online-person"
            data-online={online}
            className="flex items-center gap-2 py-0.5"
          >
            <span className={cn('relative', !online && 'opacity-50')}>
              <Avatar id={p.id} name={p.name} src={p.avatar} size={22} />
              <span
                aria-hidden
                className={cn(
                  'absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-menu',
                  online ? 'bg-green-500' : 'bg-faint',
                )}
              />
            </span>
            <span className={cn('truncate', !online && 'text-muted')}>{p.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Toasts: someone pinged by hand ---------------------------------------------------------

interface PingToast {
  key: number;
  docId: string;
  fromName: string;
}

let toastKey = 0;
const TOAST_MS = 15_000;

/** "Ada is checking if you're here, on Plans", with Open, for manual pings. */
export function PingToasts({ onOpen }: { onOpen(pageId: PageId): void }) {
  const { platform, workspace } = useApp();
  const check = platform.onlineCheck;
  const [toasts, setToasts] = useState<PingToast[]>([]);
  useEffect(
    () =>
      check?.onPinged((ping) => {
        if (!ping.manual) return;
        const toast = { key: ++toastKey, docId: ping.docId, fromName: ping.fromName };
        setToasts((list) => [...list.filter((t) => t.docId !== ping.docId), toast].slice(-3));
        setTimeout(() => setToasts((list) => list.filter((t) => t !== toast)), TOAST_MS);
      }),
    [check],
  );
  const close = (toast: PingToast) => setToasts((list) => list.filter((t) => t !== toast));
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {toasts.map((toast) => {
        const title = getPage(workspace, toast.docId)?.title || 'Untitled';
        return (
          <div
            key={toast.key}
            role="status"
            data-testid="ping-toast"
            className="pointer-events-auto flex w-80 items-center gap-2 rounded-lg bg-menu p-3 text-sm shadow-menu"
          >
            <BellRing size={16} className="shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1">
              <b>{toast.fromName}</b> is checking if you’re here, on <b>{title}</b>
            </span>
            <Button
              onClick={() => {
                onOpen(toast.docId);
                close(toast);
              }}
            >
              Open
            </Button>
            <button
              type="button"
              aria-label="Dismiss"
              className="rounded p-1 text-muted hover:bg-hover"
              onClick={() => close(toast)}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

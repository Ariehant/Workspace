/**
 * The inbox (Phase 5 M6): the server's notifications for this person (mentions, comments
 * and replies on pages they follow, reminders, pages shared with them), an unread count
 * in the sidebar, and which kinds show as system notifications.
 */
import {
  NOTIFICATION_KINDS,
  getPage,
  parseNotification,
  type NotificationData,
  type NotificationKind,
} from '@workspace/core';
import {
  Avatar,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from '@workspace/ui';
import { Archive, ArchiveRestore, Bell, Check, CheckCheck, Inbox, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from './context';
import { useDisplayContext } from './database/hooks';
import type { NotificationsPlatform, TeamPlatform } from './platform';

export type InboxFilter = 'all' | 'mentions' | 'unread' | 'archived';
const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'unread', label: 'Unread' },
  { id: 'archived', label: 'Archived' },
];

const KIND_LABELS: Record<NotificationKind, string> = {
  mention: 'Mentions',
  comment: 'Comments on pages you follow',
  reply: 'Replies',
  reminder: 'Reminders',
  access: 'Pages shared with you',
  form: 'Responses to your forms',
  automation: 'Automations',
};

/** The server's notification endpoints (through the host's team API). */
export interface InboxApi {
  list(
    filter: InboxFilter,
    before?: number,
  ): Promise<{ notifications: NotificationData[]; unread: number; more: boolean }>;
  setRead(ids: string[] | null, read: boolean): Promise<void>;
  setArchived(ids: string[], archived: boolean): Promise<void>;
  following(pageId: string): Promise<boolean>;
  setFollowing(pageId: string, following: boolean): Promise<void>;
}

export function inboxApi(team: TeamPlatform): InboxApi {
  return {
    list: async (filter, before) => {
      const query = `filter=${filter}${before ? `&before=${before}` : ''}`;
      const result = await team.request<{
        notifications: unknown[];
        unread: number;
        more: boolean;
      }>('GET', `notifications?${query}`);
      return {
        ...result,
        // Checked like the socket's (whatever the server says is data).
        notifications: result.notifications.flatMap((n) => {
          const parsed = parseNotification(JSON.stringify(n));
          return parsed ? [parsed] : [];
        }),
      };
    },
    setRead: async (ids, read) => {
      await team.request('POST', 'notifications/read', { ids, read });
    },
    setArchived: async (ids, archived) => {
      await team.request('POST', 'notifications/archive', { ids, archived });
    },
    following: async (pageId) =>
      (await team.request<{ following: boolean }>('GET', `pages/${pageId}/follow`)).following,
    setFollowing: async (pageId, following) => {
      await team.request('PUT', `pages/${pageId}/follow`, { following });
    },
  };
}

export interface InboxState {
  api: InboxApi;
  unread: number;
  /** Bumped when a notification arrives (an open inbox reloads). */
  version: number;
  refresh(): void;
}

/** The inbox's unread count, kept current (null without a server). */
export function useInbox(
  team: TeamPlatform | null,
  notifications: NotificationsPlatform | undefined,
): InboxState | null {
  const api = useMemo(() => (team ? inboxApi(team) : null), [team]);
  const [unread, setUnread] = useState(0);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => {
    if (!api) return;
    api.list('unread').then(
      (r) => setUnread(r.unread),
      () => {},
    );
  }, [api]);
  useEffect(refresh, [refresh]);
  useEffect(
    () =>
      api && notifications
        ? notifications.onNotification(() => {
            setVersion((v) => v + 1);
            refresh();
          })
        : undefined,
    [api, notifications, refresh],
  );
  return useMemo(
    () => (api ? { api, unread, version, refresh } : null),
    [api, unread, version, refresh],
  );
}

function timeAgo(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** What a notification says, in a sentence. */
function Headline({ n, actor, page }: { n: NotificationData; actor: string; page: string }) {
  const who = <span className="font-medium">{actor}</span>;
  const where = <span className="font-medium">{page}</span>;
  switch (n.kind) {
    case 'mention':
      return (
        <>
          {who} mentioned you in {where}
        </>
      );
    case 'comment':
      return (
        <>
          {who} commented in {where}
        </>
      );
    case 'reply':
      return (
        <>
          {who} replied in {where}
        </>
      );
    case 'reminder':
      return <>Reminder in {where}</>;
    case 'access':
      return (
        <>
          {who} shared {where} with you
        </>
      );
    case 'form':
      return (
        <>
          {n.actorId ? who : 'Someone'} responded to {where}
        </>
      );
    case 'automation':
      return (
        <>
          Automation <span className="font-medium">{n.title}</span>
        </>
      );
  }
}

function Item({
  n,
  onOpen,
  onRead,
  onArchive,
}: {
  n: NotificationData;
  onOpen(): void;
  onRead(read: boolean): void;
  onArchive(archived: boolean): void;
}) {
  const { workspace } = useApp();
  const { users, avatars } = useDisplayContext();
  const actor = n.actorId ? (users.get(n.actorId) ?? 'Someone') : '';
  // The page's title now, if this device has it.
  const page = (n.pageId && getPage(workspace, n.pageId)?.title) || n.title || 'Untitled';
  const unread = n.readAt === null;
  return (
    <li
      data-testid="inbox-item"
      data-kind={n.kind}
      data-unread={unread || undefined}
      className="group/item relative flex gap-2.5 rounded-md px-2 py-2 hover:bg-hover"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 gap-2.5 text-left"
        aria-label={`Open: ${n.kind} ${page}`}
      >
        {n.actorId ? (
          <Avatar id={n.actorId} name={actor} src={avatars?.get(n.actorId)} size={24} />
        ) : (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-active">
            <Bell size={13} />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm" data-testid="inbox-headline">
            <Headline n={n} actor={actor} page={page} />{' '}
            <span className="text-xs text-faint">{timeAgo(n.createdAt)}</span>
          </span>
          {n.text && (
            <span className="line-clamp-2 text-sm text-muted" data-testid="inbox-text">
              {n.text}
            </span>
          )}
        </span>
      </button>
      {unread && (
        <span
          aria-label="Unread"
          className="mt-2 size-2 shrink-0 rounded-full bg-accent group-hover/item:hidden"
        />
      )}
      <span className="absolute top-1.5 right-1.5 hidden gap-0.5 rounded bg-menu shadow-menu group-hover/item:flex">
        <IconButton
          size="sm"
          label={unread ? 'Mark as read' : 'Mark as unread'}
          onClick={() => onRead(unread)}
        >
          <Check size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={n.archivedAt === null ? 'Archive' : 'Unarchive'}
          onClick={() => onArchive(n.archivedAt === null)}
        >
          {n.archivedAt === null ? <Archive size={14} /> : <ArchiveRestore size={14} />}
        </IconButton>
      </span>
    </li>
  );
}

function SystemSettings({ platform }: { platform: NotificationsPlatform }) {
  const kinds = platform.systemKinds;
  const [value, setValue] = useState<Partial<Record<NotificationKind, boolean>>>({});
  useEffect(() => {
    kinds?.get().then(setValue, () => {});
  }, [kinds]);
  if (!kinds) return null;
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <IconButton size="sm" label="Desktop notifications">
          <Settings2 size={14} />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="end" className="w-64" aria-label="Desktop notifications">
        <div className="px-2 py-1 text-xs text-muted">Desktop notifications</div>
        {NOTIFICATION_KINDS.map((kind) => (
          <MenuItem
            key={kind}
            role="menuitemcheckbox"
            aria-checked={value[kind] !== false}
            onSelect={(e) => {
              e.preventDefault();
              const next = { ...value, [kind]: value[kind] === false };
              setValue(next);
              kinds.set(next);
            }}
          >
            <span className="flex-1">{KIND_LABELS[kind]}</span>
            {value[kind] !== false && <Check size={14} />}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** The inbox button in the sidebar, and its panel. */
export function InboxButton({
  inbox,
  className,
  onOpen,
}: {
  inbox: InboxState;
  className: string;
  onOpen(n: NotificationData): void;
}) {
  const { platform } = useApp();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [items, setItems] = useState<NotificationData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { api, version, refresh } = inbox;
  const loading = useRef(0);

  const load = useCallback(() => {
    const ticket = ++loading.current;
    api.list(filter).then(
      (r) => {
        if (ticket !== loading.current) return;
        setItems(r.notifications);
        setError(null);
      },
      (e: unknown) => ticket === loading.current && setError(String(e)),
    );
  }, [api, filter]);
  useEffect(() => {
    if (open) load();
  }, [open, load, version]);

  const update = (ids: string[], change: Partial<NotificationData>) =>
    setItems((list) => list?.map((n) => (ids.includes(n.id) ? { ...n, ...change } : n)) ?? null);
  const setRead = (ids: string[] | null, read: boolean) => {
    if (ids) update(ids, { readAt: read ? Date.now() : null });
    else setItems((list) => list?.map((n) => ({ ...n, readAt: n.readAt ?? Date.now() })) ?? null);
    void api.setRead(ids, read).then(refresh, () => {});
  };
  const setArchived = (id: string, archived: boolean) => {
    setItems((list) => list?.filter((n) => n.id !== id) ?? null);
    void api.setArchived([id], archived).then(refresh, () => {});
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={className} data-testid="inbox-button">
          <Inbox size={16} />
          <span className="flex-1 text-left">Inbox</span>
          {inbox.unread > 0 && (
            <span
              data-testid="inbox-unread"
              aria-label={`${inbox.unread} unread`}
              className="min-w-5 rounded-full bg-accent px-1.5 text-center text-xs leading-5 font-medium text-accent-fg"
            >
              {inbox.unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="flex max-h-[70vh] w-[400px] flex-col p-0"
        aria-label="Inbox"
        data-testid="inbox"
      >
        <div className="flex items-center gap-1 border-b border-line px-3 py-2">
          <span className="flex-1 text-sm font-semibold">Inbox</span>
          <IconButton size="sm" label="Mark all as read" onClick={() => setRead(null, true)}>
            <CheckCheck size={14} />
          </IconButton>
          {platform.notifications && <SystemSettings platform={platform.notifications} />}
        </div>
        <div className="flex gap-1 px-3 pt-2" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'h-6 rounded px-2 text-xs hover:bg-hover',
                filter === f.id ? 'bg-active text-fg' : 'text-muted',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <InboxList error={error} empty={items?.length === 0}>
          {items?.map((n) => (
            <Item
              key={n.id}
              n={n}
              onOpen={() => {
                if (n.readAt === null) setRead([n.id], true);
                setOpen(false);
                onOpen(n);
              }}
              onRead={(read) => setRead([n.id], read)}
              onArchive={(archived) => setArchived(n.id, archived)}
            />
          ))}
        </InboxList>
      </PopoverContent>
    </Popover>
  );
}

function InboxList({
  error,
  empty,
  children,
}: {
  error: string | null;
  empty: boolean;
  children: ReactNode;
}) {
  if (error) return <p className="p-6 text-center text-sm text-danger">{error}</p>;
  if (empty) {
    return (
      <p className="p-8 text-center text-sm text-faint" data-testid="inbox-empty">
        You’re all caught up
      </p>
    );
  }
  return <ul className="flex-1 overflow-y-auto p-1.5">{children}</ul>;
}

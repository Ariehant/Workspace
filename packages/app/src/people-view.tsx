/**
 * People (Phase 8 N7, #28): everyone in the workspace, and the pages each one made.
 *
 * Names and pictures come from the workspace's people (a local workspace: whoever has used
 * it). A server workspace adds email and role, and its groups; guests may not see those,
 * so they get the names alone.
 */
import { isInTrash, listPages, workspaceDataDoc, type PageId } from '@workspace/core';
import { PageIcon } from '@workspace/editor';
import { Avatar, IconButton, cn } from '@workspace/ui';
import { ArrowLeft, ArrowRight, ChevronsRight, FileText, Users } from 'lucide-react';
import { useEffect, useReducer, useState } from 'react';
import { timeAgo } from './comments';
import { useApp } from './context';
import type { ChromeProps } from './page-view';
import { usePeople } from './people';
import { ROLE_LABELS, type GroupInfo, type MemberInfo } from './team';

/** What the server says about the members (null: none to ask, or not allowed). */
interface Directory {
  members: ReadonlyMap<string, MemberInfo>;
  groups: GroupInfo[];
}

function useDirectory(): Directory | null {
  const { team } = useApp();
  const [directory, setDirectory] = useState<Directory | null>(null);
  useEffect(() => {
    if (!team) return;
    let live = true;
    // A guest is refused (403): they see names only, which is all the workspace shows them.
    Promise.all([team.members(), team.groups()]).then(
      ([m, g]) => {
        if (!live) return;
        setDirectory({ members: new Map(m.members.map((x) => [x.id, x])), groups: g.groups });
      },
      () => live && setDirectory(null),
    );
    return () => {
      live = false;
    };
  }, [team]);
  return directory;
}

export function PeopleView({
  chrome,
  onOpen,
}: {
  chrome: ChromeProps;
  onOpen(pageId: PageId): void;
}) {
  const { workspace, members, user, platform, pages } = useApp();
  const people = usePeople(workspaceDataDoc(workspace), members);
  const directory = useDirectory();
  // Titles and new pages change as people work: draw again.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => pages.subscribe(bump), [pages]);

  const ids = [...new Set(people.active)].filter((id) => people.names.has(id));
  if (!ids.includes(user.id) && !directory) ids.unshift(user.id);
  const name = (id: string) =>
    people.names.get(id) || directory?.members.get(id)?.name || (id === user.id ? user.name : '');
  ids.sort((a, b) =>
    a === user.id ? -1 : b === user.id ? 1 : name(a).localeCompare(name(b), undefined),
  );
  const [selected, setSelected] = useState<string>(user.id);
  const current = ids.includes(selected) ? selected : (ids[0] ?? null);

  const created = (id: string) =>
    listPages(workspace)
      .filter((p) => p.createdBy === id && !isInTrash(workspace, p.id))
      .sort((a, b) => b.createdAt - a.createdAt);
  const theirs = current ? created(current) : [];

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface" data-testid="people">
      <header className="flex h-11 shrink-0 items-center gap-1 px-3 text-sm">
        {!chrome.sidebarOpen && (
          <IconButton label="Open sidebar (Ctrl+\)" onClick={chrome.onOpenSidebar}>
            <ChevronsRight size={18} />
          </IconButton>
        )}
        <IconButton
          label="Go back (Alt+←)"
          className="disabled:opacity-30"
          disabled={!chrome.canGoBack}
          onClick={() => chrome.onGo(-1)}
        >
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton
          label="Go forward (Alt+→)"
          className="disabled:opacity-30"
          disabled={!chrome.canGoForward}
          onClick={() => chrome.onGo(1)}
        >
          <ArrowRight size={16} />
        </IconButton>
        <span className="flex items-center gap-1.5 px-1">
          <Users size={14} aria-hidden />
          People
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-8 px-24 pt-10 pb-24 max-md:px-6">
          <h1 className="text-3xl font-bold">People</h1>

          <section aria-label="Everyone" className="flex flex-col gap-1">
            <h2 className="text-xs font-medium text-muted">
              {ids.length === 1 ? '1 person' : `${ids.length} people`}
            </h2>
            <ul className="flex flex-col" data-testid="people-list">
              {ids.map((id) => {
                const info = directory?.members.get(id);
                const count = created(id).length;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-pressed={id === current}
                      onClick={() => setSelected(id)}
                      data-testid="person"
                      className={cn(
                        'flex h-12 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-hover',
                        id === current && 'bg-active',
                      )}
                    >
                      <Avatar
                        name={name(id) || '?'}
                        src={people.avatars.get(id) ?? info?.avatar ?? undefined}
                        id={id}
                        size={28}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium" data-testid="person-name">
                          {name(id) || 'Unknown'}
                          {id === user.id && <span className="font-normal text-muted"> (you)</span>}
                        </span>
                        {info?.email && (
                          <span className="truncate text-xs text-muted">{info.email}</span>
                        )}
                      </span>
                      {info && (
                        <span className="shrink-0 text-xs text-muted" data-testid="person-role">
                          {ROLE_LABELS[info.role]}
                        </span>
                      )}
                      <span className="w-16 shrink-0 text-right text-xs text-muted tabular-nums">
                        {count === 1 ? '1 page' : `${count} pages`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {current && (
            <section
              aria-label={`Pages by ${name(current) || 'Unknown'}`}
              data-testid="person-pages"
              className="flex flex-col gap-1"
            >
              <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <FileText size={14} aria-hidden />
                Pages by {name(current) || 'Unknown'}
              </h2>
              {theirs.length === 0 ? (
                <p className="text-sm text-faint">
                  No pages yet. (Pages made before this was recorded don’t say who made them.)
                </p>
              ) : (
                <ul className="flex flex-col">
                  {theirs.map((page) => (
                    <li key={page.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(page.id)}
                        data-testid="person-page"
                        className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-hover"
                      >
                        <PageIcon icon={page.icon} size={16} fileUrl={platform.fileUrl} />
                        <span className="min-w-0 flex-1 truncate">{page.title || 'Untitled'}</span>
                        <span className="shrink-0 text-xs text-muted">
                          {timeAgo(page.createdAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {directory && directory.groups.length > 0 && (
            <section
              aria-label="Groups"
              data-testid="people-groups"
              className="flex flex-col gap-1"
            >
              <h2 className="text-xs font-medium text-muted">Groups</h2>
              <ul className="flex flex-col">
                {directory.groups.map((group) => (
                  <li
                    key={group.id}
                    className="flex h-9 items-center gap-3 px-2 text-sm"
                    data-testid="people-group"
                  >
                    <span className="font-medium">{group.name}</span>
                    <span className="min-w-0 flex-1 truncate text-muted">
                      {group.members.map((id) => name(id) || 'Unknown').join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

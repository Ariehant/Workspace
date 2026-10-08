/**
 * Comments and suggested edits on a page (Phase 5 M5): the page's comments doc, the
 * editor's side of it (a `CommentsHost`), the comments panel, and the comments under the
 * page title.
 */
import {
  REACTIONS,
  addComment,
  commentsDocId,
  createThread,
  decideSuggestion,
  deleteComment,
  deleteThread,
  editComment,
  readThreads,
  roleAllows,
  setResolved,
  toggleReaction,
  updateSuggestion,
  type CommentData,
  type PageId,
  type ThreadData,
  type TreeRole,
} from '@workspace/core';
import {
  applySuggestion,
  resolveAnchor,
  type Editor,
  type EditorComments,
  type RangeAnchor,
} from '@workspace/editor';
import { Avatar, Button, IconButton, cn } from '@workspace/ui';
import { Check, MessageSquare, MoreHorizontal, RotateCcw, SmilePlus, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type * as Y from 'yjs';
import { useApp } from './context';
import { useDisplayContext } from './database/hooks';
import { useDoc } from './hooks';

// --- The editor's side --------------------------------------------------------------------

/**
 * What the editor asks of the page's comments. Made once per page (the editor keeps it
 * for its life); the comments doc arrives later, and the app's callbacks are set on it.
 */
export class CommentsHost implements EditorComments {
  private doc: Y.Doc | null = null;
  private cache: ThreadData[] = [];
  private active: string | null = null;
  private suggestMode = false;
  private readonly listeners = new Set<() => void>();
  private handlers: {
    /** A highlight was clicked. */
    onOpen(threadId: string): void;
    /** The toolbar's Comment was pressed. */
    onComment(anchor: RangeAnchor): void;
  } = { onOpen: () => {}, onComment: () => {} };

  constructor(readonly selfId: string) {}

  /** The app's side: what to do when a highlight is clicked or Comment pressed. */
  setHandlers(handlers: CommentsHost['handlers']) {
    this.handlers = handlers;
  }

  private readonly refresh = () => {
    this.cache = this.doc ? readThreads(this.doc) : [];
    this.notify();
  };

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }

  /** The comments doc (null while it loads). Returns a cleanup. */
  attach(doc: Y.Doc | null): () => void {
    this.doc = doc;
    doc?.on('update', this.refresh);
    this.refresh();
    return () => {
      doc?.off('update', this.refresh);
      if (this.doc === doc) {
        this.doc = null;
        this.refresh();
      }
    };
  }

  readonly threads = () => this.cache;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  activeThread() {
    return this.active;
  }

  setActive(threadId: string | null) {
    if (this.active === threadId) return;
    this.active = threadId;
    this.notify();
  }

  open(threadId: string) {
    this.setActive(threadId);
    this.handlers.onOpen(threadId);
  }

  comment(anchor: RangeAnchor) {
    this.handlers.onComment(anchor);
  }

  suggesting() {
    return this.suggestMode;
  }

  setSuggesting(on: boolean) {
    if (this.suggestMode === on) return;
    this.suggestMode = on;
    this.notify();
  }

  createSuggestion(anchor: RangeAnchor, insert: string) {
    if (!this.doc) return;
    createThread(this.doc, { anchor, author: this.selfId, suggestion: { insert } });
  }

  updateSuggestion(threadId: string, change: { anchor?: RangeAnchor; insert?: string }) {
    if (this.doc) updateSuggestion(this.doc, threadId, change);
  }

  dropSuggestion(threadId: string) {
    if (this.doc) deleteThread(this.doc, threadId);
  }
}

export interface PageComments {
  doc: Y.Doc | null;
  host: CommentsHost;
  threads: ThreadData[];
  /** May add comments (and suggest edits). */
  canComment: boolean;
  /** May edit the page (accepts suggestions). */
  canEdit: boolean;
  /** Full access: may delete anyone's comment. */
  canManage: boolean;
  /** Suggest mode is on (always, for someone who may only comment). */
  suggesting: boolean;
  /** Turn suggest mode on or off (null when it can't be: they may only comment). */
  toggleSuggesting: (() => void) | null;
  panelOpen: boolean;
  setPanelOpen(open: boolean): void;
  /** A range being commented on (the composer at the top of the panel). */
  draft: RangeAnchor | null;
  setDraft(anchor: RangeAnchor | null): void;
}

// --- Opening a thread from elsewhere (the inbox) -----------------------------------------

let threadRequest: { pageId: string; threadId: string } | null = null;
const threadListeners = new Set<() => void>();

/** Show this thread in the page's comments panel (now, or when the page opens). */
export function requestThread(pageId: string, threadId: string): void {
  threadRequest = { pageId, threadId };
  for (const listener of [...threadListeners]) listener();
}

/** A page's comments while mounted (`role`: the person's access to the page). */
export function usePageComments(pageId: PageId | null, role: TreeRole): PageComments {
  const { client, user } = useApp();
  const doc = useDoc(client, pageId && roleAllows(role, 'view') ? commentsDocId(pageId) : null);
  const host = useMemo(() => new CommentsHost(user.id), [pageId, user.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => host.attach(doc), [host, doc]);
  const threads = useSyncExternalStore(host.subscribe, host.threads);
  const [panelOpen, setPanelOpen] = useState(false);
  const [draft, setDraft] = useState<RangeAnchor | null>(null);
  const [suggestChosen, setSuggestChosen] = useState(false);
  // Another page: nothing half-written carries over.
  const [shownPage, setShownPage] = useState(pageId);
  if (shownPage !== pageId) {
    setShownPage(pageId);
    setDraft(null);
  }

  const canComment = roleAllows(role, 'comment');
  const canEdit = roleAllows(role, 'edit');
  const suggesting = canComment && (!canEdit || suggestChosen);
  useEffect(() => host.setSuggesting(suggesting), [host, suggesting]);

  // The inbox asked for one of this page's threads.
  useEffect(() => {
    const take = () => {
      if (!pageId || threadRequest?.pageId !== pageId) return;
      host.setActive(threadRequest.threadId);
      threadRequest = null;
      setPanelOpen(true);
    };
    take();
    threadListeners.add(take);
    return () => void threadListeners.delete(take);
  }, [host, pageId]);

  useEffect(() => {
    host.setHandlers({
      onOpen: () => setPanelOpen(true),
      onComment: (anchor) => {
        if (!canComment) return;
        setDraft(anchor);
        setPanelOpen(true);
      },
    });
  }, [host, canComment]);

  return {
    doc,
    host,
    threads,
    canComment,
    canEdit,
    canManage: role === 'full',
    suggesting,
    toggleSuggesting: canEdit ? () => setSuggestChosen((on) => !on) : null,
    panelOpen,
    setPanelOpen,
    draft,
    setDraft,
  };
}

// --- Rendering ----------------------------------------------------------------------------

function timeAgo(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A comment's text with its `<@id>` mentions as names. */
function Body({ text, names }: { text: string; names: ReadonlyMap<string, string> }) {
  const parts = text.split(/<@([\w-]{1,64})>/g);
  return (
    <p className="text-sm break-words whitespace-pre-wrap" data-testid="comment-body">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-medium text-accent" data-testid="comment-mention">
            @{names.get(part) ?? 'Unknown'}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
}

/**
 * A comment box: Enter sends, Shift+Enter is a new line, and `@` offers people (their
 * mention is stored as `<@id>`).
 */
function Composer({
  placeholder,
  initial = '',
  autoFocus,
  submitLabel = 'Send',
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  initial?: string;
  autoFocus?: boolean;
  submitLabel?: string;
  onSubmit(body: string): void;
  onCancel?(): void;
}) {
  const { users: names, people = [] } = useDisplayContext();
  const toDisplay = useCallback(
    (body: string) =>
      body.replace(/<@([\w-]{1,64})>/g, (_, id: string) => `@${names.get(id) ?? id}`),
    [names],
  );
  const [text, setText] = useState(() => toDisplay(initial));
  // People mentioned while typing (display name -> id).
  const picked = useRef(new Map<string, string>());
  useEffect(() => {
    for (const [, id] of initial.matchAll(/<@([\w-]{1,64})>/g)) {
      if (id) picked.current.set(names.get(id) ?? id, id);
    }
  }, [initial, names]);
  const [query, setQuery] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const matches =
    query === null
      ? []
      : people
          .map((id) => ({ id, name: names.get(id) ?? id }))
          .filter((p) => p.name.toLowerCase().startsWith(query.toLowerCase()))
          .slice(0, 6);

  const updateQuery = (value: string, caret: number) => {
    const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(value.slice(0, caret));
    setQuery(m ? m[1]! : null);
  };

  const mention = (person: { id: string; name: string }) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${person.name} `);
    const next = before + text.slice(caret);
    picked.current.set(person.name, person.id);
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };

  const submit = () => {
    let body = text.trim();
    if (!body) return;
    // Longest names first, so "@Ada Lovelace" wins over "@Ada".
    const names = [...picked.current.keys()].sort((a, b) => b.length - a.length);
    for (const name of names) body = body.split(`@${name}`).join(`<@${picked.current.get(name)}>`);
    onSubmit(body);
    setText('');
    picked.current.clear();
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        rows={1}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid="comment-input"
        onChange={(e) => {
          setText(e.target.value);
          updateQuery(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (query !== null && matches.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault();
            mention(matches[0]!);
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            if (query !== null) setQuery(null);
            else onCancel?.();
          }
        }}
        className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none placeholder:text-faint focus:border-accent [field-sizing:content]"
      />
      {query !== null && matches.length > 0 && (
        <div
          role="listbox"
          aria-label="Mention a person"
          className="absolute top-full left-0 z-30 mt-1 w-56 rounded-md bg-menu p-1 shadow-menu"
        >
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => mention(p)}
              className="flex h-7 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-hover"
            >
              <Avatar id={p.id} name={p.name} size={18} />
              {p.name}
            </button>
          ))}
        </div>
      )}
      {text.trim() && (
        <div className="mt-1 flex justify-end gap-1">
          {onCancel && (
            <Button className="h-6" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button variant="primary" className="h-6 px-2" onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function Person({ id, children }: { id: string; children?: ReactNode }) {
  const { users: names, avatars } = useDisplayContext();
  const name = names.get(id) ?? 'Unknown';
  return (
    <div className="flex items-center gap-2">
      <Avatar id={id} name={name} src={avatars?.get(id)} size={20} />
      <span className="text-sm font-medium" data-testid="comment-author">
        {name}
      </span>
      {children}
    </div>
  );
}

function CommentView({
  comment,
  thread,
  comments,
}: {
  comment: CommentData;
  thread: ThreadData;
  comments: PageComments;
}) {
  const { user } = useApp();
  const { users: names } = useDisplayContext();
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<'none' | 'actions' | 'reactions'>('none');
  const doc = comments.doc!;
  const mine = comment.author === user.id;
  const canDelete = mine || comments.canManage;
  return (
    <div className="group/comment flex flex-col gap-1" data-testid="comment">
      <Person id={comment.author}>
        <span className="text-xs text-faint">
          {timeAgo(comment.createdAt)}
          {comment.editedAt !== null && ' (edited)'}
        </span>
        <span className="ml-auto flex opacity-0 group-hover/comment:opacity-100 focus-within:opacity-100">
          {comments.canComment && (
            <IconButton
              label="Add reaction"
              size="sm"
              onClick={() => setMenu(menu === 'reactions' ? 'none' : 'reactions')}
            >
              <SmilePlus size={14} />
            </IconButton>
          )}
          {(mine || canDelete) && (
            <IconButton
              label="Comment actions"
              size="sm"
              onClick={() => setMenu(menu === 'actions' ? 'none' : 'actions')}
            >
              <MoreHorizontal size={14} />
            </IconButton>
          )}
        </span>
      </Person>
      {menu === 'reactions' && (
        <div className="flex gap-0.5" role="group" aria-label="Reactions">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              className="rounded px-1 hover:bg-hover"
              onClick={() => {
                toggleReaction(doc, thread.id, comment.id, emoji, user.id);
                setMenu('none');
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      {menu === 'actions' && (
        <div className="flex gap-1 text-xs">
          {mine && (
            <Button
              className="h-6"
              onClick={() => {
                setEditing(true);
                setMenu('none');
              }}
            >
              Edit
            </Button>
          )}
          {canDelete && (
            <Button
              className="h-6 text-danger"
              onClick={() => {
                deleteComment(doc, thread.id, comment.id);
                setMenu('none');
              }}
            >
              Delete
            </Button>
          )}
        </div>
      )}
      <div className="pl-7">
        {editing ? (
          <Composer
            placeholder="Edit comment"
            initial={comment.body}
            autoFocus
            submitLabel="Save"
            onSubmit={(body) => {
              editComment(doc, thread.id, comment.id, body);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <Body text={comment.body} names={names} />
        )}
        {Object.keys(comment.reactions).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.entries(comment.reactions).map(([emoji, who]) => (
              <button
                key={emoji}
                type="button"
                disabled={!comments.canComment}
                aria-pressed={who.includes(user.id)}
                title={who.map((id) => names.get(id) ?? 'Unknown').join(', ')}
                data-testid="reaction"
                onClick={() => toggleReaction(doc, thread.id, comment.id, emoji, user.id)}
                className={cn(
                  'flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs',
                  who.includes(user.id) ? 'border-accent bg-accent/10' : 'border-line',
                )}
              >
                {emoji} {who.length}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** What a suggestion would do, in words. */
function SuggestionSummary({ thread }: { thread: ThreadData }) {
  const s = thread.suggestion!;
  const quote = thread.anchor.kind === 'range' ? thread.anchor.quote : '';
  const status =
    s.status === 'accepted' ? ' (accepted)' : s.status === 'rejected' ? ' (rejected)' : '';
  return (
    <p className="text-sm" data-testid="suggestion-summary">
      {quote && s.insert ? (
        <>
          Replace <del className="text-danger">{quote}</del> with{' '}
          <ins className="text-accent no-underline">{s.insert}</ins>
        </>
      ) : s.insert ? (
        <>
          Add <ins className="text-accent no-underline">{s.insert}</ins>
        </>
      ) : (
        <>
          Delete <del className="text-danger">{quote}</del>
        </>
      )}
      <span className="text-faint">{status}</span>
    </p>
  );
}

function ThreadView({
  thread,
  comments,
  editor,
  active,
}: {
  thread: ThreadData;
  comments: PageComments;
  editor: Editor | null;
  active: boolean;
}) {
  const { user } = useApp();
  const doc = comments.doc!;
  const s = thread.suggestion;
  const resolved = thread.resolvedAt !== null || (s !== null && s.status !== 'open');
  const quote = thread.anchor.kind === 'range' ? thread.anchor.quote : null;
  // A range whose text was deleted (it collapsed, or can't be placed) isn't in the page.
  const range =
    thread.anchor.kind === 'range' && editor ? resolveAnchor(editor.state, thread.anchor) : null;
  const orphaned =
    thread.anchor.kind === 'range' &&
    editor !== null &&
    (!range || (range.from === range.to && thread.anchor.quote !== ''));
  const decide = (status: 'accepted' | 'rejected') => {
    if (status === 'accepted' && (!editor || !applySuggestion(editor, thread))) return;
    decideSuggestion(doc, thread.id, status, user.id);
  };

  return (
    <div
      data-testid="comment-thread"
      data-thread-id={thread.id}
      data-active={active || undefined}
      onClick={() => {
        comments.host.setActive(thread.id);
        document
          .querySelector(`.ws-prose [data-thread="${CSS.escape(thread.id)}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }}
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-surface p-3',
        active ? 'border-accent shadow-sm' : 'border-line',
      )}
    >
      {s ? (
        <>
          <Person id={thread.createdBy}>
            <span className="text-xs text-faint">suggested {timeAgo(thread.createdAt)}</span>
          </Person>
          <div className="pl-7">
            <SuggestionSummary thread={thread} />
            {orphaned && s.status === 'open' && (
              <p className="text-xs text-faint">The text this changes was deleted.</p>
            )}
          </div>
          {s.status === 'open' && (comments.canEdit || thread.createdBy === user.id) && (
            <div className="flex gap-1 pl-7">
              {comments.canEdit && (
                <Button
                  variant="primary"
                  className="h-6 px-2"
                  disabled={orphaned || !editor}
                  onClick={(e) => {
                    e.stopPropagation();
                    decide('accepted');
                  }}
                >
                  <Check size={13} /> Accept
                </Button>
              )}
              <Button
                className="h-6"
                onClick={(e) => {
                  e.stopPropagation();
                  decide('rejected');
                }}
              >
                <X size={13} /> {comments.canEdit ? 'Reject' : 'Withdraw'}
              </Button>
            </div>
          )}
        </>
      ) : (
        quote !== null && (
          <blockquote
            className={cn(
              'border-l-2 pl-2 text-sm text-muted',
              orphaned ? 'border-line italic' : 'border-yellow-400',
            )}
            data-testid="comment-quote"
          >
            {orphaned ? `On deleted text: ${quote}` : quote}
          </blockquote>
        )
      )}
      {thread.comments.map((c) => (
        <CommentView key={c.id} comment={c} thread={thread} comments={comments} />
      ))}
      {comments.canComment && !resolved && (
        <div onClick={(e) => e.stopPropagation()}>
          <Composer
            placeholder={thread.comments.length > 0 ? 'Reply…' : 'Add a comment…'}
            onSubmit={(body) => addComment(doc, thread.id, user.id, body)}
          />
        </div>
      )}
      {comments.canComment && !s && (
        <div className="flex justify-end">
          <Button
            className="h-6 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              setResolved(doc, thread.id, thread.resolvedAt === null ? user.id : null);
            }}
          >
            {thread.resolvedAt === null ? (
              <>
                <Check size={13} /> Resolve
              </>
            ) : (
              <>
                <RotateCcw size={13} /> Re-open
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

const isOpen = (t: ThreadData) =>
  t.resolvedAt === null && (!t.suggestion || t.suggestion.status === 'open');

/** The comments panel beside the page. */
export function CommentsPanel({
  comments,
  editor,
}: {
  comments: PageComments;
  editor: Editor | null;
}) {
  const { user } = useApp();
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  const active = useSyncExternalStore(comments.host.subscribe, () => comments.host.activeThread());
  const { draft, setDraft, doc } = comments;
  // Opening a resolved thread (its highlight is gone, but a link might) shows its list.
  const shown = comments.threads.filter((t) => (filter === 'open' ? isOpen(t) : !isOpen(t)));
  const listRef = useRef<HTMLDivElement>(null);
  // Page edits move (or delete) the commented text: redraw.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!editor) return;
    editor.on('update', bump);
    return () => void editor.off('update', bump);
  }, [editor]);
  useEffect(() => {
    if (!active) return;
    listRef.current
      ?.querySelector(`[data-thread-id="${CSS.escape(active)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, filter]);

  return (
    <aside
      aria-label="Comments"
      data-testid="comments-panel"
      className="flex w-80 shrink-0 flex-col border-l border-line bg-sidebar"
    >
      <div className="flex h-11 items-center gap-1 px-3">
        <span className="flex-1 text-sm font-semibold">Comments</span>
        {(['open', 'resolved'] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'h-6 rounded px-2 text-xs capitalize hover:bg-hover',
              filter === f ? 'bg-active text-fg' : 'text-muted',
            )}
          >
            {f}
          </button>
        ))}
        <IconButton label="Close comments" size="sm" onClick={() => comments.setPanelOpen(false)}>
          <X size={14} />
        </IconButton>
      </div>
      <div ref={listRef} className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-6">
        {draft && doc && (
          <div className="flex flex-col gap-2 rounded-lg border border-accent bg-surface p-3">
            <blockquote className="border-l-2 border-yellow-400 pl-2 text-sm text-muted">
              {draft.quote}
            </blockquote>
            <Composer
              placeholder="Add a comment…"
              autoFocus
              submitLabel="Comment"
              onSubmit={(body) => {
                const id = createThread(doc, { anchor: draft, author: user.id, body });
                setDraft(null);
                setFilter('open');
                comments.host.setActive(id);
              }}
              onCancel={() => setDraft(null)}
            />
          </div>
        )}
        {shown.map((t) => (
          <ThreadView
            key={t.id}
            thread={t}
            comments={comments}
            editor={editor}
            active={t.id === active}
          />
        ))}
        {shown.length === 0 && !draft && (
          <p className="py-8 text-center text-sm text-faint">
            {filter === 'open' ? 'No open comments' : 'No resolved comments'}
          </p>
        )}
      </div>
    </aside>
  );
}

/** The header's comments button (with the open count). */
export function CommentsButton({ comments }: { comments: PageComments }) {
  const count = comments.threads.filter(isOpen).length;
  if (!comments.doc) return null;
  return (
    <button
      type="button"
      aria-label="Comments"
      aria-pressed={comments.panelOpen}
      onClick={() => comments.setPanelOpen(!comments.panelOpen)}
      data-testid="comments-button"
      className={cn(
        'flex h-7 items-center gap-1 rounded px-1.5 text-sm text-muted hover:bg-hover',
        comments.panelOpen && 'bg-active text-fg',
      )}
    >
      <MessageSquare size={16} />
      {count > 0 && <span data-testid="comments-count">{count}</span>}
    </button>
  );
}

/** Comments on the whole page, under its title (`composing`: a new one is being written). */
export function PageCommentsSection({
  comments,
  composing,
  onDone,
}: {
  comments: PageComments;
  composing: boolean;
  onDone(): void;
}) {
  const { user } = useApp();
  const { doc } = comments;
  const active = useSyncExternalStore(comments.host.subscribe, () => comments.host.activeThread());
  if (!doc) return null;
  const threads = comments.threads.filter((t) => t.anchor.kind === 'page' && t.resolvedAt === null);
  const showComposer = comments.canComment && (composing || threads.length > 0);
  if (threads.length === 0 && !showComposer) return null;
  return (
    <section
      aria-label="Page comments"
      data-testid="page-comments"
      className="mt-3 flex flex-col gap-2 border-b border-line pb-3"
    >
      {threads.map((t) => (
        <ThreadView
          key={t.id}
          thread={t}
          comments={comments}
          editor={null}
          active={t.id === active}
        />
      ))}
      {showComposer && (
        <div className="flex items-start gap-2">
          <Avatar id={user.id} name={user.name} size={20} className="mt-1.5" />
          <div className="flex-1">
            <Composer
              placeholder="Add a comment…"
              autoFocus={composing}
              onSubmit={(body) => {
                createThread(doc, { anchor: { kind: 'page' }, author: user.id, body });
                onDone();
              }}
              onCancel={onDone}
            />
          </div>
        </div>
      )}
    </section>
  );
}

import { PageIcon } from '../page-icon';
import { Node, mergeAttributes } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';
import { formatDate, parseDate, reminderTime, toIsoDate } from '@workspace/core';
import { Avatar, cn } from '@workspace/ui';
import { AlarmClock, ArrowUpRight, CalendarDays } from 'lucide-react';
import { forwardRef, useRef, useSyncExternalStore } from 'react';
import {
  useEditorServices,
  usePageRef,
  usePersonRef,
  type EditorServices,
  type PageRef,
  type PersonRef,
} from '../services';
import {
  floatingList,
  type SuggestionListHandle,
  type SuggestionListProps,
} from '../suggestions/floating';
import { ItemList } from '../suggestions/item-list';

export type MentionItem =
  | { kind: 'page'; page: PageRef }
  | { kind: 'person'; person: PersonRef }
  | { kind: 'date'; date: string; reminder: boolean };

const MAX_PAGES = 8;
const MAX_PEOPLE = 5;

/**
 * Dates a (possibly unfinished) query could mean: the exact parse, or completions
 * of "in N days/weeks" while it is being typed ("in", "in 2", "in 2 w").
 */
export function dateCandidates(q: string, now = new Date()): Date[] {
  const exact = q ? parseDate(q, now) : null;
  if (exact) return [exact];
  const m = /^in(?:\s+(\d{1,3})?)?(?:\s+([a-z]*))?$/.exec(q);
  if (!m) return [];
  const n = m[1] ? Number(m[1]) : 1;
  const unit = m[2] ?? '';
  return ['days', 'weeks']
    .filter((u) => u.startsWith(unit))
    .map((u) => parseDate(`in ${n} ${u}`, now))
    .filter((d): d is Date => d !== null);
}

/**
 * Suggestions for "@query": the date or reminder it parses as, then matching people
 * (the workspace's members), then matching pages.
 */
export function mentionItems(
  query: string,
  services: (Pick<EditorServices, 'listPages'> & Partial<Pick<EditorServices, 'people'>>) | null,
  now = new Date(),
): MentionItem[] {
  const q = query.trim().toLowerCase();
  const items: MentionItem[] = [];

  const remind = /^remind(?: me)?\b\s*(.*)$/.exec(q);
  if (remind) {
    const rest = remind[1] ?? '';
    const dates = rest
      ? dateCandidates(rest, now)
      : [parseDate('today', now)!, parseDate('tomorrow', now)!];
    for (const d of dates) items.push({ kind: 'date', date: toIsoDate(d), reminder: true });
    return items;
  }

  const dates = dateCandidates(q, now);
  for (const d of dates) items.push({ kind: 'date', date: toIsoDate(d), reminder: false });
  if (!q) {
    items.push({ kind: 'date', date: toIsoDate(parseDate('today', now)!), reminder: false });
    items.push({ kind: 'date', date: toIsoDate(parseDate('tomorrow', now)!), reminder: true });
  }

  const people = (services?.people?.list() ?? [])
    // "ada", "love" and "ada lo" all find Ada Lovelace.
    .filter((p) => {
      const name = p.name.toLowerCase();
      return name.startsWith(q) || name.split(/\s+/).some((word) => word.startsWith(q));
    })
    .slice(0, MAX_PEOPLE);
  for (const person of people) items.push({ kind: 'person', person });

  const pages = (services?.listPages() ?? [])
    .filter((p) => !p.inTrash && (p.title || 'untitled').toLowerCase().includes(q))
    .slice(0, MAX_PAGES);
  for (const page of pages) items.push({ kind: 'page', page });
  return items;
}

export function mentionItemLabel(item: MentionItem, now = new Date()): string {
  if (item.kind === 'page') return item.page.title || 'Untitled';
  if (item.kind === 'person') return item.person.name || 'Someone';
  const day = formatDate(item.date, now);
  if (!item.reminder) return day;
  return day === 'Today' || day === 'Tomorrow'
    ? `Remind me ${day.toLowerCase()}`
    : `Remind me on ${day}`;
}

const MentionList = forwardRef<SuggestionListHandle<MentionItem>, SuggestionListProps<MentionItem>>(
  function MentionList({ items, command, loading }, ref) {
    const fileUrl = useEditorServices().fileUrl;
    return (
      <ItemList<MentionItem>
        ref={ref}
        items={items}
        loading={loading}
        command={command}
        label="Mention"
        emptyText="No people, pages or dates found"
        keyOf={(item) =>
          item.kind === 'page'
            ? item.page.id
            : item.kind === 'person'
              ? `person:${item.person.id}`
              : `${item.date}:${item.reminder}`
        }
        sectionOf={(item) =>
          item.kind === 'page'
            ? 'Pages'
            : item.kind === 'person'
              ? 'People'
              : item.reminder
                ? 'Reminder'
                : 'Date'
        }
        renderItem={(item) => (
          <>
            <span className="flex size-5 items-center justify-center text-muted">
              {item.kind === 'page' ? (
                <PageIcon icon={item.page.icon} size={16} fileUrl={fileUrl} />
              ) : item.kind === 'person' ? (
                <Avatar name={item.person.name} src={item.person.avatar} id={item.person.id} />
              ) : item.reminder ? (
                <AlarmClock size={16} />
              ) : (
                <CalendarDays size={16} />
              )}
            </span>
            <span className="truncate">{mentionItemLabel(item)}</span>
          </>
        )}
      />
    );
  },
);

// --- The inline node -----------------------------------------------------------------

const MINUTE = 60_000;

function subscribeMinute(onChange: () => void): () => void {
  const timer = setInterval(onChange, MINUTE / 4);
  return () => clearInterval(timer);
}

/**
 * The current time, rounded down to the minute, re-rendering as it changes. Keeps
 * "Today"/"Tomorrow" labels and overdue reminders right as time passes.
 */
function useMinute(): number {
  return useSyncExternalStore(subscribeMinute, () => Math.floor(Date.now() / MINUTE) * MINUTE);
}

function MentionView({ node, updateAttributes, editor, selected }: ReactNodeViewProps) {
  const services = useEditorServices();
  const kind = node.attrs.kind as 'page' | 'person' | 'date';
  const pageId = node.attrs.pageId as string | null;
  const page = usePageRef(kind === 'page' ? pageId : null);
  const userId = node.attrs.userId as string | null;
  const person = usePersonRef(kind === 'person' ? userId : null);
  const dateInput = useRef<HTMLInputElement>(null);
  const now = useMinute();

  if (kind === 'page') {
    const missing = !page || page.inTrash;
    return (
      <NodeViewWrapper
        as="span"
        className={cn('ws-mention', selected && 'is-selected')}
        data-testid="mention"
      >
        <span
          role="link"
          onClick={() => pageId && !missing && services.navigate(pageId)}
          className={cn('ws-mention-page', missing && 'text-faint')}
        >
          <span className="ws-mention-icon">
            <PageIcon icon={page?.icon ?? null} size={14} fileUrl={services.fileUrl} />
            <ArrowUpRight size={8} strokeWidth={3} className="ws-mention-arrow" />
          </span>
          <span className="ws-mention-title">
            {!page
              ? (services.missingPage ?? 'Deleted page')
              : page.inTrash
                ? 'Deleted page'
                : page.title || 'Untitled'}
          </span>
        </span>
      </NodeViewWrapper>
    );
  }

  if (kind === 'person') {
    return (
      <NodeViewWrapper
        as="span"
        className={cn('ws-mention', selected && 'is-selected')}
        data-testid="mention"
      >
        <span className="ws-mention-person" data-user-id={userId ?? undefined}>
          @{person?.name || 'Unknown person'}
        </span>
      </NodeViewWrapper>
    );
  }

  const date = node.attrs.date as string;
  const reminder = Boolean(node.attrs.reminder);
  const due = reminderTime(date);
  const overdue = reminder && due !== null && due < now;
  return (
    <NodeViewWrapper
      as="span"
      className={cn('ws-mention', selected && 'is-selected')}
      data-testid="mention"
    >
      <span
        role="button"
        title={reminder ? `Reminder at 9:00 on ${date}` : date}
        className={cn('ws-mention-date', overdue && 'text-danger')}
        onClick={() => editor.isEditable && dateInput.current?.showPicker()}
      >
        @{formatDate(date, new Date(now))}
        {reminder && (
          <AlarmClock size={13} aria-label="Reminder" className="ml-0.5 inline align-[-2px]" />
        )}
      </span>
      <input
        ref={dateInput}
        type="date"
        tabIndex={-1}
        aria-label="Change date"
        value={date}
        onChange={(event) => event.target.value && updateAttributes({ date: event.target.value })}
        className="pointer-events-none absolute size-0 opacity-0"
      />
    </NodeViewWrapper>
  );
}

export const mentionKey = new PluginKey('mention');

const label = (attrs: Record<string, unknown>) =>
  attrs.kind === 'date' ? `@${String(attrs.date)}` : attrs.kind === 'person' ? '@person' : '@page';

/**
 * Inline @-mention of a page (live title, click to open), a person (a member of the
 * workspace, by id; the name stays current), or a date, optionally a reminder (the
 * main process notifies at 9:00 on that day).
 */
export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    const attr = (name: string, html: string, fallback: unknown = null) => ({
      default: fallback,
      parseHTML: (el: HTMLElement) => {
        const v = el.getAttribute(`data-${html}`);
        return v === null ? fallback : typeof fallback === 'boolean' ? v === 'true' : v;
      },
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs[name] === null || attrs[name] === undefined
          ? {}
          : { [`data-${html}`]: String(attrs[name]) },
    });
    return {
      kind: attr('kind', 'kind', 'page'),
      pageId: attr('pageId', 'page-id'),
      userId: attr('userId', 'user-id'),
      date: attr('date', 'date'),
      reminder: attr('reminder', 'reminder', false),
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="mention"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'mention' }), label(node.attrs)];
  },

  renderText({ node }) {
    return label(node.attrs);
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionView, { as: 'span' });
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      Suggestion<MentionItem, MentionItem>({
        editor,
        pluginKey: mentionKey,
        char: '@',
        allowSpaces: true,
        allow: ({ editor: e }) => !e.isActive('codeBlock'),
        items: ({ query }) => mentionItems(query, editor.storage.uiBridge.ref.current.services),
        command: ({ editor: e, range, props: item }) => {
          const attrs =
            item.kind === 'page'
              ? { kind: 'page', pageId: item.page.id }
              : item.kind === 'person'
                ? { kind: 'person', userId: item.person.id }
                : { kind: 'date', date: item.date, reminder: item.reminder };
          e.chain()
            .focus()
            .insertContentAt(range, [
              { type: 'mention', attrs },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
        render: floatingList<MentionItem>(MentionList, {
          testId: 'mention-menu',
          shouldExit: (props) => props.items.length === 0 && /\s\S*\s$|.{30,}/.test(props.query),
          exit: (props) => exitSuggestion(props.editor.view, mentionKey),
        }),
      }),
    ];
  },
});

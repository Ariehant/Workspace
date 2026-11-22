/**
 * The command bar (Ctrl+K): go to a date, switch the view, create an event, search events by
 * title, open settings. Arrow keys move, Enter runs, Esc closes.
 */
import { cn, Dialog, DialogContent } from '@workspace/ui';
import { CalendarSearch, CornerDownLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { dayOf } from '../shared/dates';
import type { CalEvent } from '../shared/types';
import { api, unwrap } from './api';
import { formatFullDay } from './format';
import { parseDay } from './parse-date';
import { timeLabel, titleOf } from './week';

export interface Command {
  id: string;
  label: string;
  /** The key that does the same, shown at the right. */
  shortcut?: string;
  run: () => void;
}

interface Props {
  today: string;
  commands: Command[];
  onGoTo: (day: string) => void;
  onOpenEvent: (event: CalEvent) => void;
  onClose: () => void;
}

interface Item {
  key: string;
  label: string;
  detail?: string;
  shortcut?: string;
  section: string;
  run: () => void;
}

export function CommandBar({ today, commands, onGoTo, onOpenEvent, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; events: CalEvent[] }>({
    query: '',
    events: [],
  });
  const [active, setActive] = useState(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      unwrap(api.events.search(q)).then(
        (events) => !cancelled && setFound({ query: q, events }),
        () => {},
      );
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const list: Item[] = [];
    const day = parseDay(query, today);
    if (day) {
      list.push({
        key: `go:${day}`,
        label: `Go to ${formatFullDay(day)}`,
        section: 'Go to',
        run: () => onGoTo(day),
      });
    }
    for (const c of commands) {
      if (!q || c.label.toLowerCase().includes(q))
        list.push({
          key: c.id,
          label: c.label,
          shortcut: c.shortcut,
          section: 'Commands',
          run: c.run,
        });
    }
    if (q.length >= 2 && found.query === query.trim()) {
      for (const event of found.events.slice(0, 12)) {
        list.push({
          key: `event:${event.id}`,
          label: titleOf(event),
          detail: `${formatFullDay(dayOf(event.start))} · ${timeLabel(event)}`,
          section: 'Events',
          run: () => onOpenEvent(event),
        });
      }
    }
    return list;
  }, [query, today, commands, found, onGoTo, onOpenEvent]);

  const selected = Math.min(active, Math.max(0, items.length - 1));
  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Command bar"
        hideTitle
        className="top-[12vh] w-[min(600px,calc(100vw-32px))] overflow-hidden"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <CalendarSearch className="size-4 text-faint" aria-hidden />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="command-list"
            aria-activedescendant={items[selected] ? `command-${selected}` : undefined}
            aria-label="Type a command, a date or an event"
            placeholder="Go to a date, switch the view, find an event…"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setActive((a) => Math.min(items.length - 1, a + 1));
              else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
              else if (e.key === 'Enter') run(items[selected]);
              else return;
              e.preventDefault();
            }}
          />
        </div>
        <ul
          id="command-list"
          role="listbox"
          aria-label="Results"
          className="max-h-[50vh] overflow-y-auto p-1"
        >
          {items.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted">No matches</li>
          )}
          {items.map((item, i) => (
            <li key={item.key}>
              {(i === 0 || items[i - 1]!.section !== item.section) && (
                <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-faint">
                  {item.section}
                </div>
              )}
              <div
                id={`command-${i}`}
                role="option"
                aria-selected={i === selected}
                onMouseMove={() => setActive(i)}
                onClick={() => run(item)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  i === selected && 'bg-active',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {item.label}
                  {item.detail && <span className="ml-2 text-xs text-muted">{item.detail}</span>}
                </span>
                {item.shortcut && (
                  <kbd className="rounded border border-line px-1.5 text-[11px] text-muted">
                    {item.shortcut}
                  </kbd>
                )}
                {i === selected && <CornerDownLeft className="size-3.5 text-faint" aria-hidden />}
              </div>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export const SHORTCUTS: [string, string][] = [
  ['Ctrl+K', 'Command bar: go to a date, switch view, find an event'],
  ['T', 'Today'],
  ['D / W / M / A', 'Day, week, month, agenda'],
  ['1 – 7', 'Show that many days'],
  ['J or →', 'Next period'],
  ['K or ←', 'Previous period'],
  ['C', 'Create an event'],
  ['Enter', 'Open the selected event'],
  ['Delete', 'Delete the open event'],
  ['Ctrl+Z', 'Undo a delete'],
  ['Esc', 'Close the panel, cancel a drag'],
  ['?', 'This list'],
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Keyboard shortcuts">
        <table className="m-4 mt-2 text-sm">
          <tbody>
            {SHORTCUTS.map(([keys, what]) => (
              <tr key={keys}>
                <td className="py-1 pr-6">
                  <kbd className="rounded border border-line px-1.5 py-0.5 text-xs whitespace-nowrap">
                    {keys}
                  </kbd>
                </td>
                <td className="py-1 text-muted">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}

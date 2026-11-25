/**
 * The event panel (HANDOFF.md 1): opens on a click, closes with Esc. For an event: its title,
 * start and end, all day, its calendar, its other properties (read-only), Open in Workspace and
 * Delete; for a new event: the same fields and a calendar to put it in, until it's saved.
 */
import { Button, cn, IconButton } from '@workspace/ui';
import { AlertTriangle, BellRing, ExternalLink, Loader2, Trash2, Video, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { dayOf, type EventTime } from '../shared/dates';
import type { CalEvent, Calendar } from '../shared/types';
import { colourVar } from './api';
import { timeOf, withAllDay, withEnd, withStart } from './edits';
import { editable, timeLabel, titleOf, type Draft } from './week';
import { formatFullDay } from './format';

const inputClass =
  'h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg outline-none focus:border-accent';

interface CommonProps {
  calendars: Calendar[];
  onClose: () => void;
}

type Props = CommonProps &
  (
    | {
        mode: 'event';
        event: CalEvent;
        onUpdate: (change: { title?: string; time?: EventTime }) => void;
        onDelete: () => void;
        onOpenLink: (url: string) => void;
        onDismissConflict: () => void;
        /** Opened from a notification: offer to remind again in five minutes. */
        onSnooze?: () => void;
      }
    | {
        mode: 'draft';
        draft: Draft;
        onDraftChange: (draft: Draft) => void;
        onSave: () => void;
      }
  );

/** Start or end, as a date field and (for timed events) a time field. */
function When({
  label,
  value,
  allDay,
  onChange,
}: {
  label: string;
  value: string;
  allDay: boolean;
  onChange: (value: string) => void;
}) {
  const day = dayOf(value);
  const time = value.slice(11, 16);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-11 shrink-0 text-xs text-muted">{label}</span>
      <input
        type="date"
        aria-label={`${label} date`}
        className={cn(inputClass, 'min-w-0 flex-1')}
        value={day}
        onChange={(e) =>
          e.target.value && onChange(allDay ? e.target.value : `${e.target.value}T${time}`)
        }
      />
      {!allDay && (
        <input
          type="time"
          aria-label={`${label} time`}
          step={300}
          className={cn(inputClass, 'w-[7.75rem] shrink-0')}
          value={time}
          onChange={(e) => e.target.value && onChange(`${day}T${e.target.value}`)}
        />
      )}
    </div>
  );
}

export function EventPanel(props: Props) {
  const { calendars, onClose } = props;
  const titleRef = useRef<HTMLInputElement>(null);
  const isDraft = props.mode === 'draft';
  const event = props.mode === 'event' ? props.event : null;
  const time: EventTime = props.mode === 'event' ? timeOf(props.event) : props.draft.time;
  const calendarId = props.mode === 'event' ? props.event.calendarId : props.draft.calendarId;
  const calendar = calendars.find((c) => c.id === calendarId);
  const canEdit = isDraft || editable(calendar);
  const [title, setTitle] = useState(
    props.mode === 'event' ? props.event.title : props.draft.title,
  );
  const [lastEventId, setLastEventId] = useState(event?.id);
  if (event && event.id !== lastEventId) {
    // Another event opened in the same panel.
    setLastEventId(event.id);
    setTitle(event.title);
  }

  useEffect(() => {
    if (isDraft) titleRef.current?.focus();
  }, [isDraft]);

  const setTime = (next: EventTime) => {
    if (props.mode === 'event') props.onUpdate({ time: next });
    else props.onDraftChange({ ...props.draft, time: next });
  };

  const commitTitle = () => {
    if (props.mode === 'event' && title !== props.event.title) props.onUpdate({ title });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (props.mode === 'draft') props.onSave();
    else {
      commitTitle();
      titleRef.current?.blur();
    }
  };

  return (
    <aside
      aria-label={isDraft ? 'New event' : 'Event'}
      className="flex w-[22rem] shrink-0 flex-col gap-4 overflow-x-hidden overflow-y-auto border-l border-line bg-surface p-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (props.mode === 'event') commitTitle();
          onClose();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <form onSubmit={submit} className="flex-1">
          <input
            ref={titleRef}
            aria-label="Title"
            className="w-full rounded-md bg-transparent px-1 py-0.5 text-lg font-semibold outline-none placeholder:text-faint focus:bg-hover"
            placeholder="Untitled"
            value={title}
            readOnly={!canEdit}
            onChange={(e) => {
              setTitle(e.target.value);
              if (props.mode === 'draft')
                props.onDraftChange({ ...props.draft, title: e.target.value });
            }}
            onBlur={commitTitle}
          />
        </form>
        <IconButton
          label="Close"
          onClick={() => (props.mode === 'event' ? (commitTitle(), onClose()) : onClose())}
        >
          <X className="size-4" />
        </IconButton>
      </div>

      {event?.conflict && (
        <div role="alert" className="flex flex-col gap-1 rounded-md bg-hover p-2 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-warning">
            <AlertTriangle className="size-3.5" aria-hidden />
            Changed elsewhere
          </p>
          <p className="text-muted">
            While your edit was waiting to be saved, this was changed in{' '}
            {calendar?.kind === 'google'
              ? 'Google Calendar'
              : calendar?.kind === 'caldav'
                ? 'the server'
                : 'Workspace'}{' '}
            to &ldquo;
            {titleOf(event.conflict)}&rdquo;, {formatFullDay(dayOf(event.conflict.start))},{' '}
            {timeLabel(event.conflict)}. Your edit was saved over it.
          </p>
          {props.mode === 'event' && (
            <button
              type="button"
              className="self-start text-accent hover:underline"
              onClick={props.onDismissConflict}
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={time.allDay}
            disabled={!canEdit}
            onChange={(e) => setTime(withAllDay(time, e.target.checked))}
          />
          All day
        </label>
        <fieldset disabled={!canEdit} className="flex flex-col gap-2">
          <When
            label="Starts"
            value={time.start}
            allDay={time.allDay}
            onChange={(v) => setTime(withStart(time, v))}
          />
          <When
            label="Ends"
            value={time.end}
            allDay={time.allDay}
            onChange={(v) => setTime(withEnd(time, v))}
          />
        </fieldset>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">Calendar</span>
        {props.mode === 'draft' ? (
          <select
            aria-label="Calendar"
            className={inputClass}
            value={props.draft.calendarId}
            onChange={(e) => props.onDraftChange({ ...props.draft, calendarId: e.target.value })}
          >
            {calendars
              .filter((c) => editable(c))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        ) : (
          <span className="flex items-center gap-2 text-sm">
            <span
              className="cal-swatch size-3 rounded-full"
              style={colourVar(calendar?.colour ?? 'gray')}
            />
            {calendar?.name ?? 'Unknown calendar'}
          </span>
        )}
      </div>

      {event && event.extra.length > 0 && (
        <dl className="flex flex-col gap-1.5 text-sm" aria-label="Properties">
          {event.extra.map((p) => (
            <div key={p.name} className="grid grid-cols-[96px_1fr] gap-2">
              <dt className="truncate text-xs leading-5 text-muted">{p.name}</dt>
              <dd className="min-w-0 break-words">{p.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {event?.pending && (
        <p className="flex items-center gap-1.5 text-xs text-muted" role="status">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Saving to{' '}
          {calendar?.kind === 'google'
            ? 'Google Calendar'
            : calendar?.kind === 'caldav'
              ? 'the server'
              : 'Workspace'}
          …
        </p>
      )}

      <div className="mt-auto flex flex-wrap gap-2">
        {props.mode === 'draft' ? (
          <>
            <Button variant="primary" onClick={props.onSave} disabled={!props.draft.calendarId}>
              Save
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </>
        ) : (
          <>
            {props.onSnooze && (
              <Button onClick={props.onSnooze} className="border border-line">
                <BellRing className="size-4" aria-hidden />
                Remind me in 5 minutes
              </Button>
            )}
            {props.event.meetLink && (
              <Button variant="primary" onClick={() => props.onOpenLink(props.event.meetLink!)}>
                <Video className="size-4" aria-hidden />
                Join Google Meet
              </Button>
            )}
            {props.event.url && (
              <Button
                onClick={() => props.onOpenLink(props.event.url!)}
                className="border border-line"
              >
                <ExternalLink className="size-4" aria-hidden />
                {calendar?.kind === 'google' ? 'Open in Google Calendar' : 'Open in Workspace'}
              </Button>
            )}
            {canEdit && (
              <Button onClick={props.onDelete} className="text-danger hover:text-danger">
                <Trash2 className="size-4" aria-hidden />
                Delete
              </Button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

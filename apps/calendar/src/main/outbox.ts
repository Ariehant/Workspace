/**
 * Edits made in the calendar (HANDOFF.md 2, "Sync"; 3.6): applied to the cache at once, so the
 * window shows them straight away, and sent to the source in the background, in order, retried
 * with backoff, and kept while offline.
 *
 * - Several edits to an event not sent yet become one request.
 * - A delete waits a few seconds before it's sent, so Undo is just taking it back.
 * - If the event changed at its source while an edit waited, the edit still goes (last write
 *   wins) and the event keeps the source's version to show as "Changed elsewhere".
 */
import { randomUUID } from 'node:crypto';
import type { EventTime } from '../shared/dates';
import type { CalEvent, Calendar } from '../shared/types';
import type { Cache, OpPayload, OutboxOp } from './cache';
import { WorkspaceApiError } from './workspace/client';
import type { WorkspaceEngine } from './workspace/engine';

/** How long a delete waits for Undo. */
export const UNDO_MS = 5_000;
/** Give up on an edit the source keeps refusing after this many tries. */
export const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface OutboxStatus {
  /** Edits waiting to be sent (deletes waiting for Undo included). */
  pending: number;
  /** The last edit the source refused for good (shown until the next one goes). */
  error: string | null;
}

export interface OutboxOptions {
  cache: Cache;
  engineFor: (calendar: Calendar) => WorkspaceEngine | null;
  now?: () => number;
  onChange?: () => void;
  /** Called with the next time a send is due (ms), or null; the main process sets a timer. */
  onDue?: (at: number | null) => void;
  /** Edits refused for good: their calendar is read again from the source. */
  onRefused?: (calendarId: string) => void;
}

const sourceIdOf = (eventId: string) => eventId.slice(eventId.indexOf(':') + 1);

export class Outbox {
  error: string | null = null;
  private readonly cache: Cache;
  private readonly now: () => number;
  private flushing: Promise<void> | null = null;
  private again = false;
  /** While a server can't be reached, nothing is tried before this. */
  private offlineUntil = 0;
  private offlineFailures = 0;
  /** The edit being sent right now: nothing more is folded into it (it would be lost). */
  private sendingOp: number | null = null;

  constructor(private readonly options: OutboxOptions) {
    this.cache = options.cache;
    this.now = options.now ?? Date.now;
  }

  status(): OutboxStatus {
    return { pending: this.cache.ops().length, error: this.error };
  }

  private changed() {
    this.options.onChange?.();
  }

  private calendar(id: string): Calendar {
    const calendar = this.cache.calendar(id);
    if (!calendar) throw new Error('That calendar is gone.');
    return calendar;
  }

  private markPending(eventId: string) {
    const event = this.cache.event(eventId);
    if (!event) return;
    const pending = this.cache.opsFor(eventId).some((o) => o.kind !== 'trash');
    if (!!event.pending !== pending) this.cache.putEvent({ ...event, pending });
  }

  // --- Edits ---------------------------------------------------------------------------

  /** A new event, shown at once and created at its source in the background. */
  create(calendarId: string, title: string, time: EventTime): CalEvent {
    const calendar = this.calendar(calendarId);
    if (calendar.status !== 'ok' && calendar.status !== 'needs-setup')
      throw new Error(calendar.statusMessage ?? 'This calendar is not connected.');
    const sourceId = `local-${randomUUID()}`;
    const event: CalEvent = {
      id: `${calendarId}:${sourceId}`,
      calendarId,
      sourceId,
      title,
      ...time,
      floating: !time.allDay,
      url: null,
      colour: null,
      extra: [],
      lastEdited: '',
      pending: true,
      conflict: null,
    };
    this.cache.transaction(() => {
      this.cache.putEvent(event);
      this.cache.addOp({
        eventId: event.id,
        calendarId,
        kind: 'create',
        payload: { title, time },
        notBefore: this.now(),
        baseEdited: null,
      });
    });
    this.afterEdit();
    return event;
  }

  /** Change an event's title and/or time. */
  update(eventId: string, change: { title?: string; time?: EventTime }): CalEvent {
    const event = this.cache.event(eventId);
    if (!event) throw new Error('That event is gone.');
    const next: CalEvent = {
      ...event,
      ...(change.title !== undefined && { title: change.title }),
      ...(change.time && { ...change.time, floating: !change.time.allDay }),
      pending: true,
    };
    this.cache.transaction(() => {
      this.cache.putEvent(next);
      // Not sent yet: fold this edit into the waiting one.
      const waiting = this.cache
        .opsFor(eventId)
        .find(
          (o) =>
            (o.kind === 'create' || o.kind === 'update') &&
            o.attempts === 0 &&
            o.id !== this.sendingOp,
        );
      if (waiting) {
        this.cache.updateOp({
          ...waiting,
          payload: { ...waiting.payload, ...stripUndefined(change) },
        });
      } else {
        this.cache.addOp({
          eventId,
          calendarId: event.calendarId,
          kind: 'update',
          payload: stripUndefined(change),
          notBefore: this.now(),
          baseEdited: event.lastEdited || null,
        });
      }
    });
    this.afterEdit();
    return next;
  }

  /** Delete an event: gone at once, sent to the source after `UNDO_MS` unless undone. */
  remove(eventId: string) {
    const event = this.cache.event(eventId);
    if (!event) return;
    this.cache.transaction(() => {
      this.cache.deleteEvent(eventId);
      this.cache.addOp({
        eventId,
        calendarId: event.calendarId,
        kind: 'trash',
        payload: { snapshot: event },
        notBefore: this.now() + UNDO_MS,
        baseEdited: event.lastEdited || null,
      });
    });
    this.afterEdit();
  }

  /** Take back a delete that hasn't been sent; the event as it was, or null if too late. */
  undoRemove(eventId: string): CalEvent | null {
    const op = this.cache.opsFor(eventId).find((o) => o.kind === 'trash');
    const snapshot = op?.payload.snapshot;
    if (!op || !snapshot) return null;
    const sourceId = sourceIdOf(op.eventId);
    const event: CalEvent = { ...snapshot, id: op.eventId, sourceId };
    this.cache.transaction(() => {
      this.cache.removeOp(op.id);
      this.cache.putEvent(event);
    });
    this.markPending(event.id);
    this.afterEdit();
    return this.cache.event(event.id);
  }

  /** Stop showing "Changed elsewhere" on an event. */
  dismissConflict(eventId: string) {
    const event = this.cache.event(eventId);
    if (event?.conflict) {
      this.cache.putEvent({ ...event, conflict: null });
      this.changed();
    }
  }

  private afterEdit() {
    this.changed();
    void this.flush();
  }

  // --- Sending -------------------------------------------------------------------------

  /** Send every edit that's due. One run at a time; asking during a run runs again after. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      do {
        this.again = false;
        await this.sendDue();
      } while (this.again);
    })().finally(() => {
      this.flushing = null;
      this.options.onDue?.(this.nextDue());
    });
    return this.flushing;
  }

  /** When the next waiting edit may be sent (ms), or null. */
  nextDue(): number | null {
    const ops = this.cache.ops();
    if (ops.length === 0) return null;
    const first = Math.min(...ops.map((o) => o.notBefore));
    return Math.max(first, this.offlineUntil);
  }

  private async sendDue() {
    if (this.now() < this.offlineUntil) return;
    // One edit at a time, oldest first; read again after each (sending changes the queue).
    const tried = new Set<number>();
    for (;;) {
      const op = this.cache.ops().find((o) => o.notBefore <= this.now() && !tried.has(o.id));
      if (!op) return;
      tried.add(op.id);
      const calendar = this.cache.calendar(op.calendarId);
      const engine = calendar && this.options.engineFor(calendar);
      if (!calendar || !engine) {
        this.backOff(op, "This account's token can't be read. Connect it again.");
        continue;
      }
      try {
        this.sendingOp = op.id;
        await this.send(engine, calendar, op);
        this.offlineFailures = 0;
        this.error = null;
      } catch (error) {
        if (!(error instanceof WorkspaceApiError)) {
          this.backOff(op, error instanceof Error ? error.message : String(error));
          continue;
        }
        if (
          error.code === 'network' ||
          error.code === 'rate_limited' ||
          error.code === 'unauthorized'
        ) {
          // Everything waits (offline, busy, or a token to fix): nothing counts as a failed
          // try, so no edit is dropped for it.
          this.offlineFailures++;
          this.offlineUntil =
            this.now() + Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** (this.offlineFailures - 1));
          if (error.code === 'unauthorized') this.error = error.message;
          return;
        }
        if (
          (error.code === 'object_not_found' || error.code === 'restricted_resource') &&
          op.kind !== 'create'
        ) {
          // The row is gone (or out of reach): there's nothing to change.
          this.cache.transaction(() => {
            this.cache.removeOp(op.id);
            if (op.kind === 'update') this.cache.deleteEvent(op.eventId);
          });
          this.changed();
          continue;
        }
        this.backOff(op, error.message);
      } finally {
        this.sendingOp = null;
        this.changed();
      }
    }
  }

  /** A try that failed: later, or never again after `MAX_ATTEMPTS`. */
  private backOff(op: OutboxOp, message: string) {
    const attempts = op.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.cache.removeOp(op.id);
      this.error = `An edit couldn't be saved to Workspace and was dropped: ${message}`;
      this.markPending(op.eventId);
      // Show the source's version again.
      this.options.onRefused?.(op.calendarId);
    } else {
      this.cache.updateOp({
        ...op,
        attempts,
        error: message,
        notBefore: this.now() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempts),
      });
      this.error = message;
    }
    this.changed();
  }

  private async send(engine: WorkspaceEngine, calendar: Calendar, op: OutboxOp) {
    const sourceId = sourceIdOf(op.eventId);
    if (op.kind === 'create') {
      const { title = '', time } = op.payload;
      if (!time) throw new Error('A new event without a time.');
      const { sourceId: created, event } = await engine.create(calendar, title, time);
      const newId = `${calendar.id}:${created}`;
      this.cache.transaction(() => {
        const local = this.cache.event(op.eventId);
        this.cache.removeOp(op.id);
        this.cache.deleteEvent(op.eventId);
        // Edits waiting for the new event now name its real id, and build on the row as made.
        for (const later of this.cache.opsFor(op.eventId)) {
          this.cache.updateOp({
            ...later,
            eventId: newId,
            payload: renamed(later.payload, newId, created),
            baseEdited: event?.lastEdited ?? later.baseEdited,
          });
        }
        const waiting = this.cache.opsFor(newId);
        if (waiting.some((o) => o.kind === 'trash')) return; // deleted meanwhile
        if (waiting.length > 0 && local) {
          this.cache.putEvent({
            ...local,
            id: newId,
            sourceId: created,
            url: event?.url ?? null,
            lastEdited: event?.lastEdited ?? '',
          });
        } else if (event) {
          this.cache.putEvent({ ...event, pending: false, conflict: null });
        }
      });
      return;
    }
    if (op.kind === 'update') {
      const event = await engine.update(calendar, sourceId, {
        title: op.payload.title,
        time: op.payload.time,
      });
      this.cache.transaction(() => {
        const local = this.cache.event(op.eventId);
        this.cache.removeOp(op.id);
        const waiting = this.cache.opsFor(op.eventId);
        if (waiting.length > 0) {
          if (local && event) this.cache.putEvent({ ...local, lastEdited: event.lastEdited });
          // The next edit builds on this one: a read showing it isn't a change made elsewhere.
          for (const later of waiting) {
            if (event) this.cache.updateOp({ ...later, baseEdited: event.lastEdited });
          }
          return;
        }
        if (event) {
          this.cache.putEvent({ ...event, pending: false, conflict: local?.conflict ?? null });
        } else {
          this.cache.deleteEvent(op.eventId); // it left the calendar (e.g. no longer "mine")
        }
      });
      return;
    }
    await engine.trash(sourceId);
    this.cache.removeOp(op.id);
  }
}

function stripUndefined(change: { title?: string; time?: EventTime }): OpPayload {
  return {
    ...(change.title !== undefined && { title: change.title }),
    ...(change.time && { time: change.time }),
  };
}

/** A trash's snapshot follows its event to the id it got at the source. */
function renamed(payload: OpPayload, id: string, sourceId: string): OpPayload {
  return payload.snapshot
    ? { ...payload, snapshot: { ...payload.snapshot, id, sourceId } }
    : payload;
}

/**
 * Database automations (Phase 6 M3): "when something happens to a page, do things".
 * They live in the database doc (its `automations` map), so they sync, show in history
 * and are copied with the database; only someone who may edit the database changes them.
 *
 * Everything here is pure: which automations a change starts (`triggeredBy`), and what a
 * run does (`planActions`). The server runs them (as the automation's maker, written as
 * the workspace's automations bot), and changes an automation makes never start one.
 */
import { PageField, isTimeZone, zonedTime } from '@workspace/core';
import type * as Y from 'yjs';
import { getRowMap, hasRow, setCell, setRowTitle } from './doc';
import { matchesFilter } from './filter';
import { previewFormula, resultTypeOf, toCellValue } from './formula';
import { cellValue, propertyKind, relationIds } from './properties';
import {
  RowField,
  TITLE_PROPERTY_ID,
  type DatabaseSnapshot,
  type DateValue,
  type DisplayContext,
  type FilterGroup,
  type Property,
  type Row,
} from './schema';
import { isLiveRow } from './templates';

export const AUTOMATIONS_MAP = 'automations';

/** What starts an automation. */
export type AutomationTrigger =
  | { kind: 'pageAdded' }
  /** A property edited; with `to`, only when it becomes that (an option id, true…). */
  | { kind: 'propertyEdited'; propertyId: string; to?: unknown }
  | { kind: 'schedule'; schedule: Schedule }
  /** A button property pressed on a page (pressing it notes when and by whom in its cell). */
  | { kind: 'buttonPressed'; propertyId: string };

/** What a pressed button property keeps in its cell: the last press. */
export interface ButtonPress {
  at: number;
  by: string;
}

export interface Schedule {
  every: 'day' | 'week' | 'month';
  /** Wall-clock time, `HH:MM`. */
  time: string;
  timeZone: string;
  /** Weekly: 0 = Sunday. */
  weekday?: number;
  /** Weekly on several days (0 = Sunday); when set, it's used instead of `weekday`. */
  weekdays?: number[];
  /** Monthly: the day (the month's last day when it's shorter). */
  monthDay?: number;
}

/** A value an action writes. */
export type ActionValue =
  | { kind: 'fixed'; value: unknown }
  /** Now (dates), or today. */
  | { kind: 'now' }
  /** The person whose change started it (person properties). */
  | { kind: 'triggeredBy' }
  /** The value of a property of the page that started it. */
  | { kind: 'copy'; propertyId: string }
  /** A formula over the page that started it (`prop("Name")`), as the property's type. */
  | { kind: 'formula'; expression: string };

export type AutomationAction =
  /** Set properties of the page that started it. */
  | { kind: 'setProperties'; values: Record<string, ActionValue> }
  /** Add a page to this database (from a template: its values, icon and content). */
  | {
      kind: 'addPage';
      title: string;
      values: Record<string, ActionValue>;
      templateId?: string | null;
    }
  /**
   * Set properties of the pages linked in a relation of the page that started it (in the
   * related database: `values` are by its property ids).
   */
  | { kind: 'editRelated'; relationId: string; values: Record<string, ActionValue> }
  /** Tell people (and/or the people in a person property of the page). */
  | { kind: 'notify'; people: string[]; peopleProperty: string | null; message: string }
  /** POST the page (or the run) as JSON to a URL. */
  | { kind: 'webhook'; url: string; headers: Record<string, string> };

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  /** Only pages that match (page triggers). */
  condition: FilterGroup | null;
  actions: AutomationAction[];
  /** Who made it: it acts with their access. */
  createdBy: string;
  createdAt: number;
}

// --- Storage -------------------------------------------------------------------------

const automationsMap = (doc: Y.Doc) => doc.getMap<Automation>(AUTOMATIONS_MAP);

export function readAutomations(doc: Y.Doc): Automation[] {
  const list: Automation[] = [];
  for (const [id, value] of automationsMap(doc)) {
    if (value && typeof value === 'object') list.push({ ...value, id });
  }
  return list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

export function setAutomation(doc: Y.Doc, automation: Automation): void {
  automationsMap(doc).set(automation.id, automation);
}

export function deleteAutomation(doc: Y.Doc, id: string): void {
  automationsMap(doc).delete(id);
}

// --- What starts one -----------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Does a value match an automation's "to" (an option among several counts)? */
function becomes(value: unknown, to: unknown): boolean {
  if (Array.isArray(value)) return Array.isArray(to) ? same(value, to) : value.includes(to);
  if (value && typeof value === 'object' && 'start' in value) {
    return typeof to === 'string' ? (value as DateValue).start === to : same(value, to);
  }
  return same(value, to);
}

export interface Triggered {
  automation: Automation;
  rowId: string;
}

/**
 * The automations a change to a database's rows starts: `before` and `after` are its
 * rows (templates and trashed pages don't count). Each page starts each automation at
 * most once per change.
 */
export function triggeredBy(
  automations: readonly Automation[],
  before: readonly Row[],
  after: readonly Row[],
  properties: readonly Property[],
  ctx: DisplayContext,
): Triggered[] {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const old = new Map(before.filter(isLiveRow).map((r) => [r.id, r]));
  const found: Triggered[] = [];
  for (const row of after) {
    if (!isLiveRow(row)) continue;
    const was = old.get(row.id);
    for (const automation of automations) {
      if (!automation.enabled) continue;
      const { trigger } = automation;
      let hit = false;
      if (trigger.kind === 'pageAdded') hit = !was;
      else if (trigger.kind === 'buttonPressed' && was) {
        // A new press (its time) in the button's cell.
        const now = row.values[trigger.propertyId] as ButtonPress | undefined;
        const then = was.values[trigger.propertyId] as ButtonPress | undefined;
        hit = byId.get(trigger.propertyId)?.type === 'button' && !!now && now.at !== then?.at;
      } else if (trigger.kind === 'propertyEdited' && was) {
        const property = byId.get(trigger.propertyId);
        if (property) {
          const now = cellValue(row, property);
          const then = cellValue(was, property);
          hit = !same(now, then) && (trigger.to === undefined || becomes(now, trigger.to));
          // "Becomes" means it wasn't already.
          if (hit && trigger.to !== undefined && becomes(then, trigger.to)) hit = false;
        }
      }
      if (hit && !matchesFilter(row, automation.condition, byId, ctx)) hit = false;
      if (hit) found.push({ automation, rowId: row.id });
    }
  }
  return found;
}

// --- What a run does -----------------------------------------------------------------

/** What a run of an automation does, concretely. */
export type Effect =
  | { kind: 'edit'; rowId: string; values: Record<string, unknown>; title?: string }
  | { kind: 'add'; title: string; values: Record<string, unknown>; templateId?: string }
  /** Edit pages of another database (those linked from the page that started it). */
  | {
      kind: 'editRelated';
      databaseId: string;
      rowIds: string[];
      values: Record<string, unknown>;
      title?: string;
    }
  | { kind: 'notify'; userIds: string[]; message: string; rowId: string | null }
  | { kind: 'webhook'; url: string; headers: Record<string, string>; body: WebhookBody };

/** What a webhook action sends. */
export interface WebhookBody {
  source: { type: 'automation'; automationId: string; databaseId: string };
  /** The page that started it (null for scheduled runs). */
  data: { id: string; title: string; properties: Record<string, unknown> } | null;
  triggeredAt: string;
}

export interface RunContext {
  databaseId: string;
  /** The person whose change started it (null for a schedule or an anonymous form). */
  actorId: string | null;
  now: number;
}

/** What a run can read beyond the page: for formulas, and edits in related databases. */
export interface PlanSources {
  /** The database (formulas in values read its properties). */
  snapshot?: DatabaseSnapshot;
  ctx?: DisplayContext;
  /** Another database's properties (edits in a related one); null when it isn't there. */
  propertiesOf?(databaseId: string): readonly Property[] | null;
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

/** A formula's result on the page, as a value of `property` (null when it can't be one). */
export function formulaActionValue(
  expression: string,
  row: Row | null,
  property: Property,
  snapshot: DatabaseSnapshot | undefined,
  ctx: DisplayContext,
): unknown {
  if (!row || !snapshot || !expression.trim()) return null;
  const result = previewFormula(expression, row, snapshot, ctx);
  if ('error' in result || result.value === null) return null;
  const type = resultTypeOf(result.type);
  const value = toCellValue(result.value, type);
  if (value === null) return null;
  switch (property.type) {
    case 'number':
      if (typeof value === 'number') return value;
      break;
    case 'checkbox':
      if (typeof value === 'boolean') return value;
      break;
    case 'date':
      if (type === 'date') return value;
      break;
    case 'person':
    case 'relation':
    case 'files':
      // Ids, not text: a formula's text doesn't name them.
      return null;
  }
  // Otherwise read as text would be (an option by its name, a number, a date…).
  const text = typeof value === 'string' ? value : String(value);
  if (property.type === 'title' || property.type === 'text') return text;
  const parsed = propertyKind(property.type).parse(text, property, ctx);
  // Only options the property has (an automation doesn't add options).
  const added = new Set((parsed.newOptions ?? []).map((o) => o.id));
  if (!added.size) return parsed.value;
  if (Array.isArray(parsed.value)) {
    const kept = parsed.value.filter((id) => !added.has(String(id)));
    return kept.length ? kept : null;
  }
  return added.has(String(parsed.value)) ? null : parsed.value;
}

function resolve(
  value: ActionValue,
  property: Property | undefined,
  row: Row | null,
  properties: ReadonlyMap<string, Property>,
  run: RunContext,
  sources: PlanSources,
): unknown {
  switch (value.kind) {
    case 'fixed':
      return value.value;
    case 'now':
      return property?.type === 'date' ? { start: today(run.now) } : null;
    case 'triggeredBy':
      return run.actorId && property?.type === 'person' ? [run.actorId] : null;
    case 'copy': {
      const source = properties.get(value.propertyId);
      return row && source ? cellValue(row, source) : null;
    }
    case 'formula':
      return property
        ? formulaActionValue(value.expression, row, property, sources.snapshot, {
            users: new Map(),
            ...sources.ctx,
            now: run.now,
          })
        : null;
  }
}

/**
 * The values to write, by property (stored properties only; the title separately).
 * `targets`: the properties written (another database's, for a related edit); values
 * are read from the page that started it (`properties`).
 */
function resolveValues(
  values: Record<string, ActionValue>,
  row: Row | null,
  properties: ReadonlyMap<string, Property>,
  run: RunContext,
  sources: PlanSources,
  targets: ReadonlyMap<string, Property> = properties,
): { title?: string; values: Record<string, unknown> } {
  const out: { title?: string; values: Record<string, unknown> } = { values: {} };
  for (const [propertyId, value] of Object.entries(values)) {
    const property = targets.get(propertyId);
    if (!property) continue;
    const resolved = resolve(value, property, row, properties, run, sources);
    if (propertyId === TITLE_PROPERTY_ID || property.type === 'title') {
      out.title = typeof resolved === 'string' ? resolved : '';
    } else if (!COMPUTED.has(property.type)) {
      out.values[propertyId] = resolved;
    }
  }
  return out;
}

const COMPUTED = new Set([
  'formula',
  'rollup',
  'createdTime',
  'createdBy',
  'lastEditedTime',
  'lastEditedBy',
  'uniqueId',
  'button',
]);

/** The page as a webhook sends it: its title and its properties by name. */
export function pageJson(row: Row, properties: readonly Property[]) {
  const out: Record<string, unknown> = {};
  for (const p of properties) out[p.name] = cellValue(row, p);
  return { id: row.id, title: row.title, properties: out };
}

/** The other databases an automation's actions edit (by relation): load them for a run. */
export function relatedDatabasesOf(
  automation: Automation,
  properties: readonly Property[],
): string[] {
  const ids = new Set<string>();
  for (const action of automation.actions) {
    if (action.kind !== 'editRelated') continue;
    const relation = properties.find((p) => p.id === action.relationId);
    const id = relation?.type === 'relation' ? relation.config.databaseId : undefined;
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Write a related edit into the related database's doc: its pages that are still there
 * (not trashed, not templates). Returns how many were changed.
 */
export function applyRelatedEdit(
  doc: Y.Doc,
  effect: Extract<Effect, { kind: 'editRelated' }>,
  actor: string | null,
  now = Date.now(),
): number {
  let changed = 0;
  doc.transact(() => {
    for (const rowId of effect.rowIds) {
      if (!hasRow(doc, rowId)) continue;
      const map = getRowMap(doc, rowId);
      if (map.get(PageField.trashedAt) != null || map.get(RowField.template) === true) continue;
      for (const [propertyId, value] of Object.entries(effect.values)) {
        setCell(doc, rowId, propertyId, value, actor, now);
      }
      if (effect.title !== undefined) setRowTitle(doc, rowId, effect.title, actor, now);
      changed++;
    }
  });
  return changed;
}

/** What a run does (`row`: the page that started it; null for a scheduled run). */
export function planActions(
  automation: Automation,
  row: Row | null,
  properties: readonly Property[],
  run: RunContext,
  sources: PlanSources = {},
): Effect[] {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const effects: Effect[] = [];
  for (const action of automation.actions) {
    switch (action.kind) {
      case 'setProperties': {
        if (!row) break;
        const { title, values } = resolveValues(action.values, row, byId, run, sources);
        effects.push({
          kind: 'edit',
          rowId: row.id,
          values,
          ...(title !== undefined && { title }),
        });
        break;
      }
      case 'addPage': {
        const { title, values } = resolveValues(action.values, row, byId, run, sources);
        effects.push({
          kind: 'add',
          title: title ?? action.title,
          values,
          ...(action.templateId ? { templateId: action.templateId } : {}),
        });
        break;
      }
      case 'editRelated': {
        const relation = byId.get(action.relationId);
        const databaseId = relation?.type === 'relation' ? relation.config.databaseId : undefined;
        if (!row || !relation || !databaseId) break;
        const rowIds = relationIds(cellValue(row, relation));
        const targets =
          databaseId === run.databaseId ? properties : sources.propertiesOf?.(databaseId);
        if (!rowIds.length || !targets) break;
        const { title, values } = resolveValues(
          action.values,
          row,
          byId,
          run,
          sources,
          new Map(targets.map((p) => [p.id, p])),
        );
        if (title === undefined && !Object.keys(values).length) break;
        effects.push({
          kind: 'editRelated',
          databaseId,
          rowIds,
          values,
          ...(title !== undefined && { title }),
        });
        break;
      }
      case 'notify': {
        const people = new Set(action.people);
        const fromRow = action.peopleProperty && byId.get(action.peopleProperty);
        if (row && fromRow) {
          const value = cellValue(row, fromRow);
          if (Array.isArray(value)) for (const id of value) people.add(String(id));
        }
        if (people.size === 0) break;
        effects.push({
          kind: 'notify',
          userIds: [...people],
          message: action.message || automation.name,
          rowId: row?.id ?? null,
        });
        break;
      }
      case 'webhook':
        effects.push({
          kind: 'webhook',
          url: action.url,
          headers: action.headers,
          body: {
            source: { type: 'automation', automationId: automation.id, databaseId: run.databaseId },
            data: row ? pageJson(row, properties) : null,
            triggeredAt: new Date(run.now).toISOString(),
          },
        });
        break;
    }
  }
  return effects;
}

// --- Schedules -----------------------------------------------------------------------

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A schedule's wall-clock parts in its zone, at `t`. */
function wallDate(t: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: isTimeZone(timeZone) ? timeZone : 'UTC',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Is the schedule valid (a time, a zone, and the day it needs)? */
export function isValidSchedule(s: Schedule): boolean {
  if (!TIME.test(s.time) || !isTimeZone(s.timeZone)) return false;
  if (s.every === 'week') {
    const days = weekdaysOf(s);
    return days.length > 0 && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  }
  if (s.every === 'month') {
    return Number.isInteger(s.monthDay) && s.monthDay! >= 1 && s.monthDay! <= 31;
  }
  return s.every === 'day';
}

/** When a schedule next runs after `after` (ms), in its time zone; null if invalid. */
export function nextRun(s: Schedule, after: number): number | null {
  if (!isValidSchedule(s)) return null;
  const [, hh, mm] = TIME.exec(s.time)!;
  const start = wallDate(after, s.timeZone);
  for (let i = 0; i < 400; i++) {
    // Walk wall-clock days (UTC arithmetic on the date only).
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (s.every === 'week' && !weekdaysOf(s).includes(date.getUTCDay())) continue;
    if (s.every === 'month') {
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (day !== Math.min(s.monthDay!, last)) continue;
    }
    const t = zonedTime(year, month, day, Number(hh), Number(mm), s.timeZone);
    if (t > after) return t;
  }
  return null;
}

/** The days a weekly schedule runs on (several, or its one `weekday`). */
export const weekdaysOf = (s: Schedule): number[] =>
  s.weekdays?.length ? s.weekdays : s.weekday === undefined ? [] : [s.weekday];

/** A schedule as a string (a scheduled run checks it's still the automation's schedule). */
export const scheduleKey = (s: Schedule) =>
  `${s.every}|${s.time}|${s.timeZone}|${s.weekday ?? ''}|${s.monthDay ?? ''}${
    s.weekdays?.length ? `|${[...s.weekdays].sort().join(',')}` : ''
  }`;

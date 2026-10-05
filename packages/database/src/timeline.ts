import { dayIndex, isoOfDay, shiftDateValue, withEndDay, withStartDay } from './calendar';
import { dateFromString } from './format';
import { cellValue, isDateValue } from './properties';
import type { DateValue, Property, Row, TimelineZoom, View } from './schema';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const TIMELINE_ZOOMS: { id: TimelineZoom; label: string; pxPerDay: number }[] = [
  { id: 'hours', label: 'Hours', pxPerDay: 1152 },
  { id: 'day', label: 'Day', pxPerDay: 160 },
  { id: 'week', label: 'Week', pxPerDay: 48 },
  { id: 'biweek', label: 'Bi-week', pxPerDay: 28 },
  { id: 'month', label: 'Month', pxPerDay: 14 },
  { id: 'quarter', label: 'Quarter', pxPerDay: 5 },
  { id: 'year', label: 'Year', pxPerDay: 1.6 },
];

export const pxPerDay = (zoom: TimelineZoom) =>
  TIMELINE_ZOOMS.find((z) => z.id === zoom)?.pxPerDay ?? 48;

/** The date properties a timeline reads: start (or a range), and an optional end. */
export function timelineProperties(
  view: Pick<View, 'dateProperty' | 'endDateProperty'>,
  properties: readonly Property[],
): { start: Property | undefined; end: Property | undefined } {
  const dates = properties.filter(
    (p) => p.type === 'date' || p.type === 'createdTime' || p.type === 'lastEditedTime',
  );
  const start =
    dates.find((p) => p.id === view.dateProperty) ?? dates.find((p) => p.type === 'date');
  const end =
    view.endDateProperty && view.endDateProperty !== start?.id
      ? properties.find((p) => p.id === view.endDateProperty && p.type === 'date')
      : undefined;
  return { start, end };
}

export interface TimelineSpan {
  /** Start, inclusive (ms). */
  start: number;
  /** End, exclusive (ms): the day after the last day for dates without a time. */
  end: number;
  time: boolean;
}

const msOf = (iso: string) => dateFromString(iso).getTime();

function valueSpan(value: unknown): { start: string; end: string | null } | null {
  if (typeof value === 'number') {
    const iso = new Date(value);
    const s = `${isoOfDay(dayIndex(iso))}T${String(iso.getHours()).padStart(2, '0')}:${String(iso.getMinutes()).padStart(2, '0')}`;
    return { start: s, end: null };
  }
  if (!isDateValue(value)) return null;
  return { start: value.start, end: value.end ?? null };
}

/** A row's bar on the timeline, or null when it has no start date. */
export function rowSpan(row: Row, start: Property, end?: Property): TimelineSpan | null {
  const from = valueSpan(cellValue(row, start));
  if (!from) return null;
  let last = from.end;
  if (end) {
    const to = valueSpan(cellValue(row, end));
    last = to ? (to.end ?? to.start) : null;
  }
  const time = from.start.includes('T');
  const startMs = msOf(from.start);
  if (time) {
    const endMs = last ? msOf(last.includes('T') ? last : `${last}T23:59`) : startMs + HOUR_MS;
    return { start: startMs, end: Math.max(endMs, startMs + HOUR_MS / 4), time };
  }
  const lastDay = last
    ? dayIndex(dateFromString(last.split('T')[0]!))
    : dayIndex(new Date(startMs));
  const endMs = msOf(isoOfDay(Math.max(lastDay, dayIndex(new Date(startMs))) + 1));
  return { start: startMs, end: endMs, time };
}

const shiftHours = (iso: string, hours: number) => {
  if (!iso.includes('T')) return iso;
  const d = new Date(msOf(iso) + hours * HOUR_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${isoOfDay(dayIndex(d))}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * New values after dragging a bar (`move`) or one of its edges by `days` (or, on
 * timed values in the hours zoom, `hours`). Returns the values to write by property.
 */
export function dragSpan(
  row: Row,
  start: Property,
  end: Property | undefined,
  edge: 'move' | 'start' | 'end',
  delta: { days: number; hours?: number },
): Map<string, DateValue> {
  const out = new Map<string, DateValue>();
  const from = cellValue(row, start);
  if (start.type !== 'date' || !isDateValue(from)) return out;
  const shift = (v: DateValue): DateValue => {
    if (delta.hours && v.start.includes('T')) {
      return {
        ...v,
        start: shiftHours(v.start, delta.hours),
        ...(v.end ? { end: shiftHours(v.end, delta.hours) } : {}),
      };
    }
    return shiftDateValue(v, delta.days);
  };
  const to = end ? cellValue(row, end) : null;
  if (end) {
    const endValue: DateValue = isDateValue(to) ? to : { start: from.start };
    if (edge !== 'end') out.set(start.id, shift(from));
    if (edge !== 'start') out.set(end.id, shift(endValue));
    return out;
  }
  if (edge === 'move') {
    out.set(start.id, shift(from));
  } else if (delta.hours && from.start.includes('T')) {
    const v = { ...from };
    if (edge === 'start') v.start = shiftHours(v.start, delta.hours);
    else v.end = shiftHours(v.end ?? v.start, delta.hours);
    out.set(start.id, v);
  } else {
    const startDay = dayIndex(dateFromString(from.start));
    const endDay = from.end ? dayIndex(dateFromString(from.end)) : startDay;
    out.set(
      start.id,
      edge === 'start'
        ? withStartDay(from, startDay + delta.days)
        : withEndDay(from, endDay + delta.days),
    );
  }
  return out;
}

export interface Tick {
  ms: number;
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Header ticks between two times: major labels (months, years, days) and minor ones. */
export function timelineTicks(
  from: number,
  to: number,
  zoom: TimelineZoom,
): { major: Tick[]; minor: Tick[] } {
  const major: Tick[] = [];
  const minor: Tick[] = [];
  const first = new Date(from);
  const startDay = dayIndex(first);
  const endDay = dayIndex(new Date(to));
  const dateAt = (day: number) => new Date(msOf(isoOfDay(day)));
  for (let day = startDay; day <= endDay; day++) {
    const d = dateAt(day);
    const ms = d.getTime();
    const monthStart = d.getDate() === 1;
    switch (zoom) {
      case 'hours':
        major.push({ ms, label: `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` });
        for (let h = 0; h < 24; h++) minor.push({ ms: ms + h * HOUR_MS, label: `${h}:00` });
        break;
      case 'day':
      case 'week':
      case 'biweek':
        if (monthStart || day === startDay) {
          major.push({ ms, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
        }
        minor.push({ ms, label: String(d.getDate()) });
        break;
      case 'month':
        if (monthStart || day === startDay) {
          major.push({ ms, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
        }
        if (d.getDay() === 1) minor.push({ ms, label: String(d.getDate()) });
        break;
      case 'quarter':
      case 'year':
        if ((d.getMonth() === 0 && monthStart) || day === startDay) {
          major.push({ ms, label: String(d.getFullYear()) });
        }
        if (monthStart && (zoom === 'quarter' || d.getMonth() % 3 === 0)) {
          minor.push({
            ms,
            label: zoom === 'quarter' ? MONTHS[d.getMonth()]! : `Q${d.getMonth() / 3 + 1}`,
          });
        }
        break;
    }
  }
  return { major, minor };
}

/** Pixels from the timeline's origin for a time. */
export const timelineX = (ms: number, origin: number, zoom: TimelineZoom) =>
  ((ms - origin) / DAY_MS) * pxPerDay(zoom);

import { dateFromString } from './format';
import { isDateValue } from './properties';
import type { DatabaseSnapshot, DateReminder, DateValue } from './schema';

export const DATE_REMINDERS: { id: DateReminder; label: string; withTime: boolean }[] = [
  { id: 'onDay', label: 'On day of event (9:00)', withTime: false },
  { id: '1d', label: '1 day before (9:00)', withTime: false },
  { id: '2d', label: '2 days before (9:00)', withTime: false },
  { id: '1w', label: '1 week before (9:00)', withTime: false },
  { id: 'atTime', label: 'At time of event', withTime: true },
  { id: '5m', label: '5 minutes before', withTime: true },
  { id: '10m', label: '10 minutes before', withTime: true },
  { id: '15m', label: '15 minutes before', withTime: true },
  { id: '30m', label: '30 minutes before', withTime: true },
  { id: '1h', label: '1 hour before', withTime: true },
  { id: '2h', label: '2 hours before', withTime: true },
  { id: '1d', label: '1 day before', withTime: true },
  { id: '2d', label: '2 days before', withTime: true },
];

export const reminderOptions = (withTime: boolean) =>
  DATE_REMINDERS.filter((r) => r.withTime === withTime);

const MINUTE = 60_000;
const OFFSETS: Partial<Record<DateReminder, number>> = {
  atTime: 0,
  '5m': 5 * MINUTE,
  '10m': 10 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': 60 * MINUTE,
  '2h': 120 * MINUTE,
};
const DAYS: Partial<Record<DateReminder, number>> = { onDay: 0, '1d': 1, '2d': 2, '1w': 7 };

/** When a date value's reminder fires (ms), or null without one. */
export function dateReminderTime(value: DateValue): number | null {
  const reminder = value.reminder;
  if (!reminder) return null;
  const start = dateFromString(value.start);
  if (value.start.includes('T')) {
    if (reminder in OFFSETS) return start.getTime() - OFFSETS[reminder]!;
    const days = DAYS[reminder];
    return days === undefined ? null : start.getTime() - days * 1440 * MINUTE;
  }
  const days = DAYS[reminder];
  if (days === undefined) return null;
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() - days, 9, 0).getTime();
}

export interface PropertyReminder {
  rowId: string;
  propertyId: string;
  fireAt: number;
  /** Notification text: the property and the row title. */
  text: string;
}

/** Reminders set on date properties of live rows. */
export function readDateReminders(snapshot: DatabaseSnapshot): PropertyReminder[] {
  const dates = snapshot.properties.filter((p) => p.type === 'date');
  return snapshot.rows
    .filter((row) => row.trashedAt === null && !row.isTemplate)
    .flatMap((row) =>
      dates.flatMap((property) => {
        const value = row.values[property.id];
        const fireAt = isDateValue(value) ? dateReminderTime(value) : null;
        return fireAt === null
          ? []
          : [
              {
                rowId: row.id,
                propertyId: property.id,
                fireAt,
                text: `${property.name}: ${row.title || 'Untitled'}`,
              },
            ];
      }),
    );
}

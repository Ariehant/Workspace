import { ME, TODAY } from '@workspace/core';
import type { DateValue, Property } from './schema';

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Whether a value holds a placeholder (`@today` in a date, `@me` in people). */
/** A date value, possibly holding `@today` (which `isDateValue` rejects). */
const isDateLike = (v: unknown): v is DateValue =>
  typeof v === 'object' && v !== null && typeof (v as DateValue).start === 'string';

export function hasPlaceholder(value: unknown): boolean {
  if (isDateLike(value)) return value.start === TODAY || value.end === TODAY;
  return Array.isArray(value) && value.includes(ME);
}

/**
 * Property values with placeholders filled in: `@today` (date start or end) becomes
 * the day it's used, `@me` (in a person list) the person using it.
 */
export function resolvePlaceholders(
  values: Readonly<Record<string, unknown>>,
  properties: readonly Property[],
  context: { me: string | null; now?: number },
): Record<string, unknown> {
  const today = isoDay(new Date(context.now ?? Date.now()));
  const types = new Map(properties.map((p) => [p.id, p.type]));
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) {
    const type = types.get(id);
    if (type === 'date' && isDateLike(value)) {
      out[id] = {
        ...value,
        start: value.start === TODAY ? today : value.start,
        ...(value.end ? { end: value.end === TODAY ? today : value.end } : {}),
      };
    } else if (type === 'person' && Array.isArray(value)) {
      const people = value.flatMap((p) => (p === ME ? (context.me ? [context.me] : []) : [p]));
      out[id] = [...new Set(people)];
    } else {
      out[id] = value;
    }
  }
  return out;
}

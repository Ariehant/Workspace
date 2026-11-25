import type { CSSProperties } from 'react';
import type { Result } from '../shared/ipc';

/** The bridge to the main process (see `../preload`). */
export const api = window.calendar;

/** A bridge call's value, or an `Error` with the message the main process gave. */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const result = await call;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** The CSS variable for a calendar colour: a colour name, or a hex colour (Google's). */
export const colourVar = (colour: string) =>
  ({
    '--cal-colour': /^#[0-9a-f]{6}$/i.test(colour) ? colour : `var(--cal-${colour})`,
  }) as CSSProperties;

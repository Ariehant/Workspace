const UUID = /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

/** An id in either of Notion's forms (dashed or not), dashed and lower case; null if it isn't one. */
export function parseId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = UUID.exec(raw.trim());
  return m ? m.slice(1).join('-').toLowerCase() : null;
}

/** Ids as Notion's page URLs write them: without dashes. */
export const compactId = (id: string) => id.replace(/-/g, '');

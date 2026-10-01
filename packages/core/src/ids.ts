/** Stable, globally unique identifier for pages, blocks and documents. */
export function newId(): string {
  return crypto.randomUUID();
}

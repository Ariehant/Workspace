import type * as Y from 'yjs';

/**
 * Replace the contents of `ytext` with `next` by applying only the changed span,
 * so a concurrent edit elsewhere in the same text survives the merge.
 */
export function applyTextDiff(ytext: Y.Text, next: string): void {
  const prev = ytext.toString();
  if (prev === next) return;

  let start = 0;
  const maxStart = Math.min(prev.length, next.length);
  while (start < maxStart && prev.charCodeAt(start) === next.charCodeAt(start)) start++;

  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (
    prevEnd > start &&
    nextEnd > start &&
    prev.charCodeAt(prevEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    prevEnd--;
    nextEnd--;
  }

  const apply = () => {
    if (prevEnd > start) ytext.delete(start, prevEnd - start);
    if (nextEnd > start) ytext.insert(start, next.slice(start, nextEnd));
  };
  if (ytext.doc) ytext.doc.transact(apply);
  else apply();
}

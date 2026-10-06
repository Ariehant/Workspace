/** An edit to a code block's text: delete `remove` characters at `at`, then insert `insert`. */
export interface LineEdit {
  at: number;
  remove: number;
  insert: string;
}

/** Offsets where each line of `text` starts. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/**
 * Indent (or outdent) every line the selection [from, to] touches by `size` spaces.
 * Outdenting removes up to `size` leading spaces (or one tab). A selection ending at
 * the very start of a line leaves that line alone, as editors do. Edits are returned
 * last to first, so they can be applied in order without shifting each other.
 */
export function indentLines(
  text: string,
  from: number,
  to: number,
  outdent: boolean,
  size = 2,
): LineEdit[] {
  const starts = lineStarts(text);
  const lineOf = (offset: number) => {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1]! <= offset) line++;
    return line;
  };
  const first = lineOf(from);
  let last = lineOf(to);
  if (last > first && starts[last] === to) last--;
  const edits: LineEdit[] = [];
  for (let line = last; line >= first; line--) {
    const at = starts[line]!;
    if (!outdent) {
      edits.push({ at, remove: 0, insert: ' '.repeat(size) });
      continue;
    }
    const rest = text.slice(at);
    const spaces = /^ */.exec(rest)![0].length;
    const remove = rest.startsWith('\t') ? 1 : Math.min(spaces, size);
    if (remove > 0) edits.push({ at, remove, insert: '' });
  }
  return edits;
}

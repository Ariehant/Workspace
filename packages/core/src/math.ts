import type * as Y from 'yjs';

/** Workspace-wide settings shared by everyone in the workspace (synced with it). */
const SETTINGS_MAP = 'settings';
const MATH_MACROS = 'mathMacros';

/** KaTeX macros: `\R` -> `\mathbb{R}`. */
export type MathMacros = Record<string, string>;

const settingsMap = (doc: Y.Doc) => doc.getMap<unknown>(SETTINGS_MAP);

export function getMathMacros(doc: Y.Doc): MathMacros {
  const value = settingsMap(doc).get(MATH_MACROS);
  return value && typeof value === 'object' ? { ...(value as MathMacros) } : {};
}

export function setMathMacros(doc: Y.Doc, macros: MathMacros): void {
  settingsMap(doc).set(MATH_MACROS, { ...macros });
}

/** Call `listener` whenever the workspace's macros change. */
export function observeMathMacros(doc: Y.Doc, listener: () => void): () => void {
  const map = settingsMap(doc);
  const onChange = (event: Y.YMapEvent<unknown>) => {
    if (event.keysChanged.has(MATH_MACROS)) listener();
  };
  map.observe(onChange);
  return () => map.unobserve(onChange);
}

/**
 * Read macros written one per line: `\R \mathbb{R}`, `\R = \mathbb{R}` or `\R: \mathbb{R}`.
 * Blank lines and `%` comments are skipped; other lines are reported by number.
 */
export function parseMathMacros(text: string): { macros: MathMacros; invalid: number[] } {
  const macros: MathMacros = {};
  const invalid: number[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('%')) return;
    const match = /^(\\[A-Za-z]+|\\.)\s*(?:[=:]\s*|\s+)(.+)$/.exec(line);
    if (match) macros[match[1]!] = match[2]!.trim();
    else invalid.push(i + 1);
  });
  return { macros, invalid };
}

export function formatMathMacros(macros: MathMacros): string {
  return Object.entries(macros)
    .map(([name, body]) => `${name} ${body}`)
    .join('\n');
}

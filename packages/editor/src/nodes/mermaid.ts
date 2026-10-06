import type { Mermaid } from 'mermaid';

let loading: Promise<Mermaid> | null = null;
let theme: 'default' | 'dark' | null = null;
let counter = 0;

/** Mermaid, loaded the first time a diagram is shown (it's large). */
function load(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default);
  return loading;
}

export type MermaidResult = { svg: string; error: null } | { svg: null; error: string };

/**
 * Render diagram source to SVG. Runs with Mermaid's strict security level (no scripts,
 * no click handlers, sanitized labels); the SVG is then shown as an image, which can't
 * run anything either.
 */
export async function renderMermaid(code: string, dark: boolean): Promise<MermaidResult> {
  const mermaid = await load();
  const wanted = dark ? 'dark' : 'default';
  if (theme !== wanted) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: wanted,
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      // Plain SVG text: HTML labels (foreignObject) don't render inside an <img>.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    theme = wanted;
  }
  const id = `ws-mermaid-${++counter}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return { svg, error: null };
  } catch (error) {
    // A failed render can leave its scratch element behind.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    const message = error instanceof Error ? error.message : String(error);
    return { svg: null, error: message.trim() };
  }
}

/** The diagram's own width (from its viewBox), so the image isn't stretched to fit. */
export function svgWidth(svg: string): number | undefined {
  const box = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) [\d.]+"/.exec(svg);
  return box ? Math.ceil(Number(box[1])) : undefined;
}

/** The SVG as a data URL for an <img>. */
export const svgDataUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

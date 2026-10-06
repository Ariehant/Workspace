import type { LanguageFn } from 'highlight.js';
import { common, createLowlight } from 'lowlight';

/** Mermaid diagram source: keywords, arrows, strings and `%%` comments. */
const mermaid: LanguageFn = (hljs) => ({
  name: 'Mermaid',
  keywords: {
    keyword:
      'graph flowchart sequenceDiagram classDiagram stateDiagram stateDiagram-v2 erDiagram ' +
      'gantt pie journey gitGraph mindmap timeline quadrantChart requirementDiagram ' +
      'subgraph end participant actor loop alt else opt par and critical break rect note ' +
      'over activate deactivate title section class state direction click style linkStyle ' +
      'classDef dateFormat axisFormat TB TD BT RL LR',
  },
  contains: [
    hljs.COMMENT('%%', '$'),
    hljs.QUOTE_STRING_MODE,
    { className: 'operator', begin: /<?[-=.]{2,}[>x)o]?|-->|==>|-\.->|\|/ },
    { className: 'number', begin: /\b\d+(\.\d+)?\b/ },
  ],
});

/** Highlighting: highlight.js's ~35 common languages up front, plus Mermaid. */
export const lowlight = createLowlight(common);
lowlight.register({ mermaid });

// Every other highlight.js grammar, each its own chunk, loaded when a block uses it.
const MORE = import.meta.glob<LanguageFn>(
  ['../../node_modules/highlight.js/es/languages/*.js', '!**/*.js.js'],
  { import: 'default' },
);
const lazy = new Map(
  Object.entries(MORE).map(([path, load]) => [/([^/]+)\.js$/.exec(path)![1]!, load]),
);

/** Load a language's grammar if it isn't registered yet. Resolves whether it is now. */
export async function ensureLanguage(id: string): Promise<boolean> {
  if (lowlight.registered(id)) return true;
  const load = lazy.get(id);
  if (!load) return false;
  lowlight.register({ [id]: await load() });
  return true;
}

// Display names that are not just the capitalized grammar id.
const LABELS: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  graphql: 'GraphQL',
  ini: 'INI / TOML',
  javascript: 'JavaScript',
  json: 'JSON',
  makefile: 'Makefile',
  markdown: 'Markdown',
  matlab: 'MATLAB',
  objectivec: 'Objective-C',
  php: 'PHP',
  'php-template': 'PHP template',
  'python-repl': 'Python REPL',
  scss: 'SCSS',
  shell: 'Shell session',
  sql: 'SQL',
  typescript: 'TypeScript',
  vbnet: 'VB.NET',
  wasm: 'WebAssembly',
  xml: 'HTML / XML',
  yaml: 'YAML',
  cmake: 'CMake',
  glsl: 'GLSL',
  vhdl: 'VHDL',
  verilog: 'Verilog',
  latex: 'LaTeX',
  dockerfile: 'Dockerfile',
  protobuf: 'Protocol Buffers',
  armasm: 'ARM assembly',
  x86asm: 'x86 assembly',
};

const label = (id: string) => LABELS[id] ?? id[0]!.toUpperCase() + id.slice(1);
const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

export interface LanguageOption {
  id: string;
  label: string;
}

/** Languages offered first: plain text, the common set and Mermaid. */
export const COMMON_LANGUAGES: LanguageOption[] = [
  { id: 'plaintext', label: 'Plain text' },
  ...lowlight
    .listLanguages()
    .filter((id) => id !== 'plaintext')
    .map((id) => ({ id, label: label(id) }))
    .sort(byLabel),
];

/** The rest, loaded when picked. */
export const MORE_LANGUAGES: LanguageOption[] = [...lazy.keys()]
  .filter((id) => !lowlight.registered(id))
  .map((id) => ({ id, label: label(id) }))
  .sort(byLabel);

export const languageLabel = (id: string) => (id === 'plaintext' ? 'Plain text' : label(id));

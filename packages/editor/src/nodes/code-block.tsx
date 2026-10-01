import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from '@tiptap/react';
import { cn } from '@workspace/ui';
import { common, createLowlight } from 'lowlight';
import { Check, Copy, WrapText } from 'lucide-react';
import { useState } from 'react';

/** highlight.js "common" set: ~35 popular languages, small enough to bundle eagerly. */
export const lowlight = createLowlight(common);

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
};

const LANGUAGES = [
  { id: 'plaintext', label: 'Plain text' },
  ...lowlight
    .listLanguages()
    .filter((id) => id !== 'plaintext')
    .map((id) => ({ id, label: LABELS[id] ?? id[0]!.toUpperCase() + id.slice(1) }))
    .sort((a, b) => a.label.localeCompare(b.label)),
];

function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const [copied, setCopied] = useState(false);
  const language = (node.attrs.language as string | null) ?? 'plaintext';
  const wrap = Boolean(node.attrs.wrap);

  const copy = async () => {
    await navigator.clipboard.writeText(node.textContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <NodeViewWrapper className="ws-code-block" data-wrap={wrap || undefined}>
      <div className="ws-code-toolbar" contentEditable={false}>
        <select
          aria-label="Code language"
          value={language}
          disabled={!editor.isEditable}
          onChange={(event) => updateAttributes({ language: event.target.value })}
          className="ws-code-language"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.id} value={lang.id}>
              {lang.label}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Wrap code"
          aria-pressed={wrap}
          title="Wrap code"
          onClick={() => updateAttributes({ wrap: !wrap })}
          className={cn('ws-code-button', wrap && 'text-accent')}
        >
          <WrapText size={14} />
        </button>
        <button
          type="button"
          aria-label="Copy code"
          title="Copy"
          onClick={copy}
          className="ws-code-button"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre>
        <NodeViewContent<'code'> as="code" className={`hljs language-${language}`} />
      </pre>
    </NodeViewWrapper>
  );
}

export const CodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      wrap: {
        default: false,
        parseHTML: (el) => el.hasAttribute('data-wrap'),
        renderHTML: (attrs) => (attrs.wrap ? { 'data-wrap': '' } : {}),
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight, defaultLanguage: 'plaintext', enableTabIndentation: true });

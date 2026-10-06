import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from '@tiptap/react';
import { cn } from '@workspace/ui';
import { Captions, Check, Copy, ListOrdered, WrapText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { indentLines, lineStarts } from './code-lines';
import { COMMON_LANGUAGES, MORE_LANGUAGES, ensureLanguage, lowlight } from './languages';
import { renderMermaid, svgDataUrl, svgWidth, type MermaidResult } from './mermaid';

export { lowlight };

export type MermaidView = 'code' | 'preview' | 'split';
const MERMAID_VIEWS: { id: MermaidView; label: string }[] = [
  { id: 'code', label: 'Code' },
  { id: 'preview', label: 'Preview' },
  { id: 'split', label: 'Split' },
];

const isDark = () => document.documentElement.dataset.theme === 'dark';

/** The diagram for Mermaid source, re-rendered (debounced) as it's edited. */
function useMermaid(code: string, enabled: boolean): MermaidResult | null {
  const [result, setResult] = useState<{ code: string; dark: boolean; out: MermaidResult } | null>(
    null,
  );
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    if (!enabled) return;
    const observer = new MutationObserver(() => setDark(isDark()));
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !code.trim()) return;
    let live = true;
    const timer = setTimeout(() => {
      void renderMermaid(code, dark).then((out) => live && setResult({ code, dark, out }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, dark, enabled]);
  if (!enabled || !code.trim()) return null;
  return result?.out ?? null;
}

/** Re-highlight a block once its grammar has loaded (an attribute-preserving no-op). */
function rehighlight(editor: Editor, getPos: () => number | undefined) {
  const pos = getPos();
  if (pos === undefined || editor.isDestroyed) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, node.attrs);
  editor.view.dispatch(tr.setMeta('addToHistory', false));
}

function CodeBlockView({ node, updateAttributes, editor, getPos }: ReactNodeViewProps) {
  const [copied, setCopied] = useState(false);
  const language = (node.attrs.language as string | null) ?? 'plaintext';
  const wrap = Boolean(node.attrs.wrap);
  const lineNumbers = Boolean(node.attrs.lineNumbers);
  const caption = node.attrs.caption as string | null;
  const isMermaid = language === 'mermaid';
  const view = (node.attrs.mermaidView as MermaidView | null) ?? 'split';
  const code = node.textContent;
  const diagram = useMermaid(code, isMermaid && view !== 'code');
  const editable = editor.isEditable;

  // A language outside the common set: load it, then highlight again.
  useEffect(() => {
    let live = true;
    void ensureLanguage(language).then((ok) => ok && live && rehighlight(editor, getPos));
    return () => {
      live = false;
    };
    // Only when the language changes; getPos/editor are stable for the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const pickLanguage = async (id: string) => {
    await ensureLanguage(id);
    updateAttributes({ language: id });
  };

  return (
    <NodeViewWrapper
      className="ws-code-block"
      data-wrap={wrap || undefined}
      data-line-numbers={lineNumbers || undefined}
      data-mermaid-view={isMermaid ? view : undefined}
    >
      <div className="ws-code-toolbar" contentEditable={false}>
        <select
          aria-label="Code language"
          value={language}
          disabled={!editable}
          onChange={(event) => void pickLanguage(event.target.value)}
          className="ws-code-language"
        >
          {COMMON_LANGUAGES.map((lang) => (
            <option key={lang.id} value={lang.id}>
              {lang.label}
            </option>
          ))}
          <optgroup label="More languages">
            {MORE_LANGUAGES.map((lang) => (
              <option key={lang.id} value={lang.id}>
                {lang.label}
              </option>
            ))}
          </optgroup>
        </select>
        {isMermaid && (
          <div className="ws-code-modes" role="group" aria-label="Diagram view">
            {MERMAID_VIEWS.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={view === m.id}
                onClick={() => updateAttributes({ mermaidView: m.id })}
                className={cn('ws-code-mode', view === m.id && 'ws-code-mode-on')}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Line numbers"
          aria-pressed={lineNumbers}
          title="Line numbers"
          disabled={!editable}
          onClick={() => updateAttributes({ lineNumbers: !lineNumbers })}
          className={cn('ws-code-button', lineNumbers && 'text-accent')}
        >
          <ListOrdered size={14} />
        </button>
        <button
          type="button"
          aria-label="Caption"
          aria-pressed={caption !== null}
          title="Caption"
          disabled={!editable}
          onClick={() => updateAttributes({ caption: caption === null ? '' : null })}
          className={cn('ws-code-button', caption !== null && 'text-accent')}
        >
          <Captions size={14} />
        </button>
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
      {isMermaid && view !== 'code' && (
        <div contentEditable={false} className="ws-mermaid" data-testid="mermaid">
          {diagram?.svg && (
            <img
              src={svgDataUrl(diagram.svg)}
              width={svgWidth(diagram.svg)}
              alt="Diagram"
              data-testid="mermaid-diagram"
            />
          )}
          {diagram?.error && (
            <pre className="ws-mermaid-error" role="alert" data-testid="mermaid-error">
              {diagram.error}
            </pre>
          )}
          {!code.trim() && <p className="text-faint">Write a diagram, e.g. graph TD; A--&gt;B</p>}
        </div>
      )}
      {caption !== null && (
        <input
          contentEditable={false}
          value={caption}
          readOnly={!editable}
          placeholder="Write a caption…"
          aria-label="Code caption"
          onChange={(event) => updateAttributes({ caption: event.target.value })}
          onKeyDown={(event) => event.stopPropagation()}
          className="ws-code-caption"
        />
      )}
    </NodeViewWrapper>
  );
}

const lineNumbersKey = new PluginKey('codeLineNumbers');

/** Line numbers as widgets at the start of each line, so they follow wrapping and aren't copied. */
function lineNumberDecorations(state: EditorState, typeName: string): DecorationSet {
  const decorations: Decoration[] = [];
  state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== typeName) return true;
    if (!node.attrs.lineNumbers) return false;
    const starts = lineStarts(node.textContent);
    const width = String(starts.length).length;
    starts.forEach((offset, i) => {
      decorations.push(
        Decoration.widget(
          pos + 1 + offset,
          () => {
            const span = document.createElement('span');
            span.className = 'ws-line-number';
            span.textContent = String(i + 1).padStart(width, ' ');
            span.setAttribute('aria-hidden', 'true');
            return span;
          },
          { side: -1, key: `ln-${i + 1}-${width}`, ignoreSelection: true },
        ),
      );
    });
    return false;
  });
  return DecorationSet.create(state.doc, decorations);
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
      lineNumbers: {
        default: false,
        parseHTML: (el) => el.hasAttribute('data-line-numbers'),
        renderHTML: (attrs) => (attrs.lineNumbers ? { 'data-line-numbers': '' } : {}),
      },
      caption: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-caption'),
        renderHTML: (attrs) =>
          attrs.caption !== null ? { 'data-caption': attrs.caption as string } : {},
      },
      mermaidView: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-mermaid-view'),
        renderHTML: (attrs) =>
          attrs.mermaidView ? { 'data-mermaid-view': attrs.mermaidView as string } : {},
      },
    };
  },
  addKeyboardShortcuts() {
    const size = this.options.tabSize ?? 4;
    // Tab / Shift+Tab indent and outdent every selected line (a cursor: its line,
    // except that Tab at a cursor inserts spaces there).
    const indent = (outdent: boolean) => () => {
      const { state, view } = this.editor;
      const { $from, $to, from, to, empty } = state.selection;
      if ($from.parent.type !== this.type || $to.parent !== $from.parent) return false;
      if (empty && !outdent) {
        view.dispatch(state.tr.insertText(' '.repeat(size)));
        return true;
      }
      const start = $from.start();
      const edits = indentLines($from.parent.textContent, from - start, to - start, outdent, size);
      const tr = state.tr;
      for (const edit of edits) {
        if (edit.remove) tr.delete(start + edit.at, start + edit.at + edit.remove);
        if (edit.insert) tr.insertText(edit.insert, start + edit.at);
      }
      view.dispatch(tr);
      return true;
    };
    return { ...this.parent?.(), Tab: indent(false), 'Shift-Tab': indent(true) };
  },
  addProseMirrorPlugins() {
    const name = this.name;
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: lineNumbersKey,
        state: {
          init: (_, state) => lineNumberDecorations(state, name),
          apply: (tr, old, _oldState, state) =>
            tr.docChanged ? lineNumberDecorations(state, name) : old,
        },
        props: { decorations: (state) => lineNumbersKey.getState(state) as DecorationSet },
      }),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight, defaultLanguage: 'plaintext', enableTabIndentation: true });

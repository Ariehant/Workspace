import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { formatMathMacros, parseMathMacros } from '@workspace/core';
import katex from 'katex';
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useEditorServices } from './services';

export interface MathTarget {
  node: PMNode;
  pos: number;
}

/** The equation as it will render, or KaTeX's error for it (shown while typing). */
function preview(latex: string, block: boolean, macros: Record<string, string>) {
  if (!latex.trim()) return { html: '', error: null };
  try {
    return {
      // A copy: \gdef in the input would otherwise change the workspace's macros.
      html: katex.renderToString(latex, {
        displayMode: block,
        throwOnError: true,
        strict: false,
        macros: { ...macros },
      }),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { html: null, error: message.replace(/^KaTeX parse error: /, '') };
  }
}

/** Popover for editing an equation's TeX source. */
export function MathEditor({
  editor,
  target,
  onClose,
}: {
  editor: Editor;
  target: MathTarget;
  onClose(): void;
}) {
  const block = target.node.type.name === 'blockMath';
  const [latex, setLatex] = useState((target.node.attrs.latex as string) ?? '');
  const ref = useRef<HTMLFormElement>(null);
  const services = useEditorServices();
  const [macrosOpen, setMacrosOpen] = useState(false);
  const [macroText, setMacroText] = useState('');
  const [copied, setCopied] = useState(false);
  // The workspace's macros, following changes (e.g. saved just below).
  const macrosJson = useSyncExternalStore(services.mathMacros.subscribe, () =>
    JSON.stringify(services.mathMacros.get()),
  );
  const shown = useMemo(
    () => preview(latex, block, JSON.parse(macrosJson) as Record<string, string>),
    [latex, block, macrosJson],
  );
  const parsedMacros = useMemo(() => parseMathMacros(macroText), [macroText]);

  useLayoutEffect(() => {
    const anchor = editor.view.nodeDOM(target.pos) as HTMLElement | null;
    const el = ref.current;
    if (!anchor || !el) return;
    void computePosition(anchor, el, {
      placement: 'bottom-start',
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => Object.assign(el.style, { left: `${x}px`, top: `${y}px` }));
  }, [editor, target.pos]);

  const save = () => {
    // Focus synchronously rather than with chain().focus(): TipTap's focus() runs a frame
    // later and then rewrites the DOM selection, undoing a key pressed in between.
    editor.view.focus();
    const chain = editor.chain();
    if (block && !latex.trim()) chain.deleteBlockMath({ pos: target.pos });
    else if (block) chain.updateBlockMath({ latex, pos: target.pos });
    else if (!latex.trim()) chain.deleteInlineMath({ pos: target.pos });
    else chain.updateInlineMath({ latex, pos: target.pos });
    chain.run();
    onClose();
  };

  return (
    <form
      ref={ref}
      className="ws-floating flex w-96 flex-col gap-2 rounded-lg bg-menu p-2 text-sm text-fg shadow-menu"
      data-testid="math-editor"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <textarea
        autoFocus
        value={latex}
        onChange={(event) => setLatex(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            editor.view.focus();
            onClose();
          } else if (event.key === 'Enter' && (!block || event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          }
        }}
        rows={block ? 3 : 1}
        placeholder={block ? 'E = mc^2' : 'x^2'}
        aria-label="TeX equation"
        spellCheck={false}
        className="resize-none rounded border border-line bg-surface p-2 font-mono text-sm outline-none focus:border-accent"
      />
      {shown.error ? (
        <p className="text-xs text-danger" role="alert" data-testid="math-error">
          {shown.error}
        </p>
      ) : (
        shown.html && (
          <div
            className="max-h-32 overflow-auto rounded bg-surface px-2 py-1"
            data-testid="math-preview"
            // KaTeX output (no raw HTML from the input: `trust` is off).
            dangerouslySetInnerHTML={{ __html: shown.html }}
          />
        )
      )}
      {macrosOpen && (
        <div className="flex flex-col gap-1" data-testid="math-macros">
          <label className="text-xs text-muted" htmlFor="ws-math-macros">
            Macros for the whole workspace, one per line: <code>\R \mathbb{'{R}'}</code>
          </label>
          <textarea
            id="ws-math-macros"
            value={macroText}
            onChange={(event) => setMacroText(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            rows={4}
            spellCheck={false}
            aria-label="Equation macros"
            className="resize-none rounded border border-line bg-surface p-2 font-mono text-xs outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-danger">
              {parsedMacros.invalid.length > 0 &&
                `Line ${parsedMacros.invalid.join(', ')} isn't a macro`}
            </span>
            <button
              type="button"
              disabled={parsedMacros.invalid.length > 0}
              onClick={() => {
                services.mathMacros.set(parsedMacros.macros);
                setMacrosOpen(false);
              }}
              className="h-6 rounded px-2 text-xs hover:bg-hover disabled:opacity-50"
            >
              Save macros
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-1">
        <span className="flex-1 text-xs text-muted">{block ? 'Ctrl+Enter' : 'Enter'} to save</span>
        <button
          type="button"
          onClick={() => {
            setMacroText(formatMathMacros(services.mathMacros.get()));
            setMacrosOpen((open) => !open);
          }}
          className="h-7 rounded px-2 text-xs text-muted hover:bg-hover"
        >
          Macros
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(latex);
            setCopied(true);
          }}
          className="h-7 rounded px-2 text-xs text-muted hover:bg-hover"
        >
          {copied ? 'Copied' : 'Copy LaTeX'}
        </button>
        <button type="submit" className="h-7 rounded bg-accent px-3 text-sm text-accent-fg">
          Done
        </button>
      </div>
    </form>
  );
}

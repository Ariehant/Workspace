import {
  FUNCTIONS,
  SPECIAL_FUNCTIONS,
  formatValue,
  previewFormula,
  setPropertyConfig,
  tokenize,
  typeName,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type DisplayContext,
  type FnDef,
  type Property,
  type Row,
  type Span,
  type Token,
} from '@workspace/database';
import { Button, Dialog, DialogContent, cn } from '@workspace/ui';
import { AlertCircle, Sigma } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { PropertyIcon } from './cells';

export interface FormulaEditorProps {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  property: Property;
  /** Row the live preview evaluates (the first row when opened from the header). */
  row: Row | undefined;
  ctx: DisplayContext;
  onClose(): void;
}

type Suggestion =
  | { kind: 'property'; property: Property }
  | {
      kind: 'function';
      fn: Pick<FnDef, 'name' | 'signature' | 'description' | 'example' | 'category'>;
    }
  | { kind: 'keyword'; name: string; description: string };

const KEYWORDS: { name: string; description: string }[] = [
  { name: 'true', description: 'The boolean true.' },
  { name: 'false', description: 'The boolean false.' },
  { name: 'and', description: 'True if both sides are true.' },
  { name: 'or', description: 'True if either side is true.' },
  { name: 'not', description: 'The opposite of what follows.' },
  {
    name: 'current',
    description: 'The current item, inside map, filter, find, some, every and sort.',
  },
  { name: 'index', description: 'The index of the current item (from 0), inside map and filter.' },
];

const ALL_FUNCTIONS = [...SPECIAL_FUNCTIONS, ...FUNCTIONS.values()];

/** What is being typed at the caret: a word, or a property name inside `prop("…`. */
function completionAt(
  source: string,
  caret: number,
): { prefix: string; start: number; inProp: boolean } {
  const before = source.slice(0, caret);
  const prop = /prop\(\s*"([^"]*)$/.exec(before);
  if (prop) return { prefix: prop[1]!, start: caret - prop[1]!.length, inProp: true };
  const word = /[\p{L}\p{N}_]*$/u.exec(before)![0];
  return { prefix: word, start: caret - word.length, inProp: false };
}

/** Colored spans of the formula text, with the error range underlined. */
function highlight(source: string, error: Span | null): ReactNode[] {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch {
    tokens = [];
  }
  const parts: { text: string; className: string; start: number }[] = [];
  let pos = 0;
  tokens.forEach((token, i) => {
    if (token.start > pos) {
      const gap = source.slice(pos, token.start);
      parts.push({
        text: gap,
        className: /\/[/*]/.test(gap) ? 'text-faint italic' : '',
        start: pos,
      });
    }
    if (token.type === 'eof') return;
    const prev = tokens[i - 1];
    const prev2 = tokens[i - 2];
    const next = tokens[i + 1];
    let className = '';
    if (token.type === 'string') {
      className =
        prev?.value === '(' && prev2?.value === 'prop'
          ? 'text-[var(--ws-purple)] font-medium'
          : 'text-[var(--ws-green)]';
    } else if (token.type === 'number') className = 'text-[var(--ws-orange)]';
    else if (token.type === 'ident') {
      if (next?.value === '(') className = 'text-[var(--ws-blue)]';
      else if (['true', 'false', 'and', 'or', 'not'].includes(token.value))
        className = 'text-[var(--ws-red)]';
      else if (['current', 'index'].includes(token.value))
        className = 'italic text-[var(--ws-pink)]';
    } else className = 'text-muted';
    parts.push({ text: source.slice(token.start, token.end), className, start: token.start });
    pos = token.end;
  });
  if (pos < source.length) parts.push({ text: source.slice(pos), className: '', start: pos });

  // Split parts at the error range so it can be underlined.
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    const end = part.start + part.text.length;
    if (!error || error.end <= part.start || error.start >= end) {
      out.push(
        <span key={i} className={part.className}>
          {part.text}
        </span>,
      );
      return;
    }
    const a = Math.max(error.start, part.start) - part.start;
    const b = Math.min(error.end, end) - part.start;
    out.push(
      <span key={i} className={part.className}>
        {part.text.slice(0, a)}
        <span className="underline decoration-danger decoration-wavy underline-offset-4">
          {part.text.slice(a, b)}
        </span>
        {part.text.slice(b)}
      </span>,
    );
  });
  // Errors at the very end ("unexpected end") get a visible marker.
  if (error && error.start >= source.length) {
    out.push(
      <span key="end" className="underline decoration-danger decoration-wavy">
        {' '}
      </span>,
    );
  }
  return out;
}

/** Edit a formula property's expression. */
export function FormulaEditor({
  handle,
  snapshot,
  property,
  row,
  ctx,
  onClose,
}: FormulaEditorProps) {
  const [source, setSource] = useState(property.config.expression ?? '');
  const [caret, setCaret] = useState(source.length);
  const [active, setActive] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const others = snapshot.properties.filter((p) => p.id !== property.id);
  const result = useMemo(
    () => (source.trim() ? previewFormula(source, row, snapshot, ctx, property.id) : null),
    [source, row, snapshot, ctx, property.id],
  );
  const error = result && 'error' in result ? result.error : null;

  const completion = completionAt(source, caret);
  const q = completion.prefix.toLowerCase();
  const suggestions: Suggestion[] = completion.inProp
    ? others
        .filter((p) => p.name.toLowerCase().includes(q))
        .map((p) => ({ kind: 'property' as const, property: p }))
    : [
        ...others
          .filter((p) => !q || p.name.toLowerCase().includes(q))
          .map((p) => ({ kind: 'property' as const, property: p })),
        ...ALL_FUNCTIONS.filter((f) => !q || f.name.toLowerCase().startsWith(q)).map((fn) => ({
          kind: 'function' as const,
          fn,
        })),
        ...(q
          ? KEYWORDS.filter((k) => k.name.startsWith(q) && k.name !== q).map((k) => ({
              kind: 'keyword' as const,
              ...k,
            }))
          : []),
      ];
  // Suggestions take Enter/Tab only while a word (or property name) is being typed.
  const completing = (completion.inProp || q.length > 0) && suggestions.length > 0;
  const index = Math.min(active, Math.max(suggestions.length - 1, 0));
  const selected = suggestions[index];

  const replaceRange = (start: number, end: number, text: string, caretOffset = text.length) => {
    const next = source.slice(0, start) + text + source.slice(end);
    setSource(next);
    const pos = start + caretOffset;
    setCaret(pos);
    setActive(0);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(pos, pos);
    });
  };

  const accept = (s: Suggestion) => {
    const { start } = completion;
    if (s.kind === 'property') {
      if (completion.inProp) {
        // Complete the name and close the call if it isn't closed yet.
        const rest = source.slice(caret);
        const closed = /^[^"]*"\s*\)/.exec(rest);
        const end = closed ? caret + closed[0].length : caret;
        replaceRange(start, end, `${s.property.name}")`);
      } else {
        replaceRange(start, caret, `prop("${s.property.name}")`);
      }
    } else if (s.kind === 'function') {
      const name = s.fn.name;
      const noArgs = FUNCTIONS.get(name)?.params.length === 0;
      replaceRange(start, caret, `${name}()`, noArgs ? name.length + 2 : name.length + 1);
    } else {
      replaceRange(start, caret, s.name);
    }
  };

  const save = () => {
    if (error) return;
    const { resultType: _r, formulaError: _e, ...config } = property.config;
    void _r;
    void _e;
    setPropertyConfig(handle.doc, property.id, { ...config, expression: source.trim() });
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
      return;
    }
    if (!completing) return;
    if (e.key === 'ArrowDown') setActive(Math.min(index + 1, suggestions.length - 1));
    else if (e.key === 'ArrowUp') setActive(Math.max(index - 1, 0));
    else if ((e.key === 'Enter' || e.key === 'Tab') && selected) accept(selected);
    else return;
    e.preventDefault();
  };

  const docs = (s: Suggestion | undefined): ReactNode => {
    if (!s) return null;
    if (s.kind === 'property') {
      return (
        <>
          <p className="font-mono text-sm">prop("{s.property.name}")</p>
          <p className="mt-1 text-muted">The {s.property.name} property of this page.</p>
        </>
      );
    }
    if (s.kind === 'keyword') {
      return (
        <>
          <p className="font-mono text-sm">{s.name}</p>
          <p className="mt-1 text-muted">{s.description}</p>
        </>
      );
    }
    return (
      <>
        <p className="font-mono text-sm" data-testid="formula-docs-signature">
          {s.fn.signature}
        </p>
        <p className="mt-1 text-muted">{s.fn.description}</p>
        <p className="mt-2 text-xs text-faint">Example</p>
        <p className="font-mono text-xs">{s.fn.example}</p>
      </>
    );
  };

  const label = (s: Suggestion) =>
    s.kind === 'property' ? s.property.name : s.kind === 'function' ? s.fn.name : s.name;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Edit formula: ${property.name}`}
        hideTitle
        className="top-[10vh] w-[min(820px,calc(100vw-32px))]"
        data-testid="formula-editor"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Sigma size={16} className="text-muted" />
          <span className="font-medium">{property.name}</span>
          <span className="text-muted">formula</span>
        </div>
        <div className="p-3">
          <div className="relative rounded-md border border-line bg-surface focus-within:border-accent">
            <pre
              aria-hidden
              className="pointer-events-none absolute inset-0 m-0 overflow-hidden p-3 font-mono text-sm leading-6 break-words whitespace-pre-wrap text-fg"
            >
              {highlight(source, error?.span ?? null)}
              {'\n'}
            </pre>
            <textarea
              ref={textarea}
              autoFocus
              spellCheck={false}
              value={source}
              aria-label="Formula"
              placeholder='Type a formula, e.g. prop("Price") * prop("Qty")'
              onChange={(e) => {
                setSource(e.target.value);
                setCaret(e.target.selectionStart);
                setActive(0);
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              className="relative block min-h-24 w-full resize-none bg-transparent p-3 font-mono text-sm leading-6 break-words whitespace-pre-wrap text-transparent caret-[var(--ws-fg)] outline-none placeholder:text-faint [field-sizing:content]"
            />
          </div>
          <div className="mt-2 min-h-6 text-sm" aria-live="polite">
            {error ? (
              <p className="flex items-center gap-1.5 text-danger" data-testid="formula-error">
                <AlertCircle size={14} /> {error.message}
              </p>
            ) : result && 'value' in result ? (
              <p className="flex items-center gap-2" data-testid="formula-preview">
                <span className="text-muted">{row ? `= ` : 'Result type:'}</span>
                {row && (
                  <span className="font-mono" data-testid="formula-preview-value">
                    {formatValue(result.value) || <span className="text-faint">empty</span>}
                  </span>
                )}
                <span
                  className="rounded bg-hover px-1.5 text-xs text-muted"
                  data-testid="formula-type"
                >
                  {typeName(result.type)}
                </span>
                {row && <span className="text-xs text-faint">for “{row.title || 'Untitled'}”</span>}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex h-72 border-t border-line">
          <div
            role="listbox"
            aria-label="Suggestions"
            className="w-64 shrink-0 overflow-y-auto border-r border-line p-1"
            data-testid="formula-suggestions"
          >
            {suggestions.map((s, i) => {
              const header =
                i === 0 ||
                suggestions[i - 1]!.kind !== s.kind ||
                (s.kind === 'function' &&
                  (suggestions[i - 1] as typeof s).fn.category !== s.fn.category)
                  ? s.kind === 'property'
                    ? 'Properties'
                    : s.kind === 'keyword'
                      ? 'Keywords'
                      : s.fn.category
                  : null;
              return (
                <div key={`${s.kind}:${label(s)}`}>
                  {header && (
                    <p className="px-2 pt-2 pb-0.5 text-xs font-medium text-faint">{header}</p>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === index}
                    onMouseMove={() => i !== index && setActive(i)}
                    onClick={() => accept(s)}
                    className={cn(
                      'flex h-7 w-full items-center gap-2 rounded px-2 text-left text-sm',
                      i === index && 'bg-hover',
                    )}
                  >
                    {s.kind === 'property' ? (
                      <PropertyIcon type={s.property.type} />
                    ) : (
                      <span className="w-3.5 text-center font-mono text-xs text-faint">
                        {s.kind === 'function' ? 'ƒ' : '·'}
                      </span>
                    )}
                    <span className={cn('truncate', s.kind !== 'property' && 'font-mono')}>
                      {label(s)}
                    </span>
                  </button>
                </div>
              );
            })}
            {suggestions.length === 0 && <p className="px-2 py-1.5 text-muted">No matches</p>}
          </div>
          <div className="flex-1 overflow-y-auto p-4 text-sm" data-testid="formula-docs">
            {docs(selected)}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2">
          <span className="mr-auto text-xs text-faint">Ctrl+Enter to save</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            disabled={!!error}
            onClick={save}
            className="bg-accent text-accent-fg hover:bg-accent/90 hover:text-accent-fg disabled:opacity-50"
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

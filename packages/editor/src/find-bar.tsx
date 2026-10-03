import type { Editor } from '@tiptap/react';
import { cn } from '@workspace/ui';
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react';
import {
  SearchQuery,
  findNext,
  findPrev,
  getSearchState,
  replaceAll,
  replaceNext,
  setSearchState,
} from 'prosemirror-search';
import { useEffect, useRef, useState } from 'react';

const MAX_COUNT = 999;

/** Count matches, and which one the selection is on. */
function countMatches(editor: Editor, query: SearchQuery): { total: number; current: number } {
  const { state } = editor;
  let total = 0;
  let current = 0;
  let pos = 0;
  const { from, to } = state.selection;
  while (total < MAX_COUNT) {
    const match = query.findNext(state, pos);
    if (!match || match.to <= pos) break;
    total++;
    if (match.from === from && match.to === to) current = total;
    pos = match.to;
  }
  return { total, current };
}

/** Find (and replace) in the page; opened with Ctrl+F. */
export function FindBar({ editor, onClose }: { editor: Editor; onClose(): void }) {
  const [search, setSearch] = useState(() => getSearchState(editor.state)?.query.search ?? '');
  const [replace, setReplace] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [counts, setCounts] = useState({ total: 0, current: 0 });
  const input = useRef<HTMLInputElement>(null);

  // Push the query into the search plugin (which highlights matches).
  useEffect(() => {
    const query = new SearchQuery({ search, replace, caseSensitive, literal: true });
    editor.view.dispatch(setSearchState(editor.state.tr, query));
    const update = () =>
      setCounts(query.valid ? countMatches(editor, query) : { total: 0, current: 0 });
    update();
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor, search, replace, caseSensitive]);

  // Clear the highlights when the bar closes.
  useEffect(
    () => () => {
      if (!editor.isDestroyed)
        editor.view.dispatch(setSearchState(editor.state.tr, new SearchQuery({ search: '' })));
    },
    [editor],
  );

  const run = (command: typeof findNext) => {
    command(editor.state, editor.view.dispatch, editor.view);
    editor.commands.scrollIntoView();
  };

  const close = () => {
    onClose();
    editor.view.focus();
  };

  const button =
    'flex size-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:opacity-40';
  return (
    <div
      role="search"
      aria-label="Find in page"
      data-testid="find-bar"
      className="fixed top-12 right-4 z-40 flex w-[22rem] flex-col gap-1 rounded-lg bg-menu p-1.5 text-sm text-fg shadow-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Toggle replace"
          aria-pressed={showReplace}
          onClick={() => setShowReplace((v) => !v)}
          className={cn(button, showReplace && 'text-accent')}
        >
          <Replace size={15} />
        </button>
        <input
          ref={input}
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              run(event.shiftKey ? findPrev : findNext);
            }
          }}
          placeholder="Find in page"
          aria-label="Find"
          className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-2 outline-none focus:border-accent"
        />
        <span className="w-14 text-center text-xs text-muted" data-testid="find-count">
          {search
            ? `${counts.current}/${counts.total >= MAX_COUNT ? `${MAX_COUNT}+` : counts.total}`
            : ''}
        </span>
        <button
          type="button"
          aria-label="Match case"
          aria-pressed={caseSensitive}
          title="Match case"
          onClick={() => setCaseSensitive((v) => !v)}
          className={cn(button, 'text-xs font-semibold', caseSensitive && 'text-accent')}
        >
          Aa
        </button>
        <button
          type="button"
          aria-label="Previous match"
          disabled={!counts.total}
          onClick={() => run(findPrev)}
          className={button}
        >
          <ChevronUp size={15} />
        </button>
        <button
          type="button"
          aria-label="Next match"
          disabled={!counts.total}
          onClick={() => run(findNext)}
          className={button}
        >
          <ChevronDown size={15} />
        </button>
        <button type="button" aria-label="Close find" onClick={close} className={button}>
          <X size={15} />
        </button>
      </div>
      {showReplace && (
        <div className="flex items-center gap-1 pl-8">
          <input
            value={replace}
            onChange={(event) => setReplace(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                run(replaceNext);
              }
            }}
            placeholder="Replace with"
            aria-label="Replace"
            className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-2 outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={!counts.total || !editor.isEditable}
            onClick={() => run(replaceNext)}
            className="h-7 rounded px-2 text-xs hover:bg-hover disabled:opacity-40"
          >
            Replace
          </button>
          <button
            type="button"
            disabled={!counts.total || !editor.isEditable}
            onClick={() => run(replaceAll)}
            className="h-7 rounded px-2 text-xs hover:bg-hover disabled:opacity-40"
          >
            All
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Comments and suggested edits in the editor (Phase 5 M5).
 *
 * - Commented text is highlighted; clicking it opens its thread.
 * - A suggestion shows its range struck through and its text underlined after it.
 * - In "suggest edits" mode, typing and deleting don't change the page: they become (or
 *   extend) the person's suggestion, which someone who may edit accepts or rejects.
 *
 * Anchors are Yjs relative positions into the page content (see `@workspace/core`
 * comments), made and resolved through y-tiptap's mapping between ProseMirror and Yjs.
 */
import { Extension, type Editor } from '@tiptap/core';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import {
  decodeAnchorPosition,
  encodeAnchorPosition,
  type CommentAnchor,
  type ThreadData,
} from '@workspace/core';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';

export type RangeAnchor = Extract<CommentAnchor, { kind: 'range' }>;

/** What the page's comments are, and what to do with them (the app's side). */
export interface EditorComments {
  /** This person (their suggestions are the ones they extend). */
  selfId: string;
  threads(): ThreadData[];
  /** Call `listener` when threads change. */
  subscribe(listener: () => void): () => void;
  /** The thread shown as selected (its highlight stands out). */
  activeThread(): string | null;
  /** A highlight was clicked. */
  open(threadId: string): void;
  /** Comment on a range (the toolbar's Comment, or Ctrl+Shift+M). */
  comment(anchor: RangeAnchor): void;
  /** Typing makes suggestions instead of edits. */
  suggesting(): boolean;
  createSuggestion(anchor: RangeAnchor, insert: string): void;
  updateSuggestion(threadId: string, change: { anchor?: RangeAnchor; insert?: string }): void;
  /** A suggestion whose text was all deleted again, on an empty range. */
  dropSuggestion(threadId: string): void;
}

const key = new PluginKey<DecorationSet>('ws-comments');
/** Meta: redraw (the threads changed). */
const REFRESH = 'ws-comments-refresh';
/** Meta: a change that goes through even in suggest mode (accepting a suggestion). */
export const APPLY_SUGGESTION = 'ws-apply-suggestion';

interface Binding {
  type: Y.XmlFragment;
  doc: Y.Doc;
  mapping: Map<unknown, unknown>;
}

function binding(state: EditorState): Binding | null {
  const sync = ySyncPluginKey.getState(state) as
    | { type: Y.XmlFragment; doc: Y.Doc; binding: { mapping: Map<unknown, unknown> } | null }
    | undefined;
  if (!sync?.binding) return null;
  return { type: sync.type, doc: sync.doc, mapping: sync.binding.mapping };
}

/** An anchor for positions `from`–`to` of the editor's document. */
export function anchorFor(state: EditorState, from: number, to: number): RangeAnchor | null {
  const b = binding(state);
  if (!b) return null;
  const rel = (pos: number) =>
    encodeAnchorPosition(absolutePositionToRelativePosition(pos, b.type, b.mapping as never));
  return {
    kind: 'range',
    start: rel(from),
    end: rel(to),
    quote: state.doc.textBetween(from, to, ' ').slice(0, 300),
  };
}

/** Where an anchor is now (null if its text is gone or it can't be placed). */
export function resolveAnchor(
  state: EditorState,
  anchor: CommentAnchor,
): { from: number; to: number } | null {
  if (anchor.kind !== 'range') return null;
  const b = binding(state);
  if (!b) return null;
  const at = (text: string) => {
    const rel = decodeAnchorPosition(text);
    return rel ? relativePositionToAbsolutePosition(b.doc, b.type, rel, b.mapping as never) : null;
  };
  const from = at(anchor.start);
  const to = at(anchor.end);
  if (from === null || to === null || to < from) return null;
  return { from, to };
}

/** Replace a suggestion's range with its text (accepting it). False if it can't be placed. */
export function applySuggestion(editor: Editor, thread: ThreadData): boolean {
  if (!thread.suggestion) return false;
  const range = resolveAnchor(editor.state, thread.anchor);
  if (!range) return false;
  const tr = editor.state.tr;
  if (thread.suggestion.insert) tr.insertText(thread.suggestion.insert, range.from, range.to);
  else tr.delete(range.from, range.to);
  editor.view.dispatch(tr.setMeta(APPLY_SUGGESTION, true));
  return true;
}

function decorations(state: EditorState, host: EditorComments): DecorationSet {
  const decos: Decoration[] = [];
  const active = host.activeThread();
  for (const thread of host.threads()) {
    if (thread.anchor.kind !== 'range' || thread.resolvedAt !== null) continue;
    const s = thread.suggestion;
    if (s && s.status !== 'open') continue;
    const range = resolveAnchor(state, thread.anchor);
    if (!range) continue;
    const attrs = { 'data-thread': thread.id };
    if (s) {
      if (range.to > range.from) {
        decos.push(
          Decoration.inline(range.from, range.to, { ...attrs, class: 'ws-suggest-delete' }),
        );
      }
      if (s.insert) {
        decos.push(
          Decoration.widget(
            range.to,
            () => {
              const el = document.createElement('span');
              el.className = 'ws-suggest-insert';
              el.dataset.thread = thread.id;
              el.dataset.testid = 'suggestion-insert';
              el.textContent = s.insert;
              return el;
            },
            { side: -1, key: `${thread.id}:${s.insert}` },
          ),
        );
      }
    } else if (range.to > range.from) {
      decos.push(
        Decoration.inline(range.from, range.to, {
          ...attrs,
          class: thread.id === active ? 'ws-comment is-active' : 'ws-comment',
        }),
      );
    }
  }
  return DecorationSet.create(state.doc, decos);
}

/** My open suggestion whose range ends (`edge: 'end'`) or starts at `pos`. */
function mineAt(
  state: EditorState,
  host: EditorComments,
  pos: number,
  edge: 'start' | 'end',
): { thread: ThreadData; from: number; to: number } | null {
  for (const thread of host.threads()) {
    if (thread.createdBy !== host.selfId || thread.suggestion?.status !== 'open') continue;
    if (thread.resolvedAt !== null) continue;
    const range = resolveAnchor(state, thread.anchor);
    if (range && (edge === 'end' ? range.to : range.from) === pos) {
      return { thread, ...range };
    }
  }
  return null;
}

/**
 * Where the caret is in the DOM. The editor's own selection can lag a moment behind (it is
 * read from `selectionchange`, after a key that moved the caret), and a suggestion's
 * redraw would put that stale selection back, moving the caret.
 */
function domSelection(view: EditorView): TextSelection | null {
  const dom = (view.root as Document).getSelection?.() ?? document.getSelection();
  if (!dom?.anchorNode || !dom.focusNode || !view.dom.contains(dom.anchorNode)) return null;
  try {
    const { doc } = view.state;
    const anchor = doc.resolve(view.posAtDOM(dom.anchorNode, dom.anchorOffset));
    const head = doc.resolve(view.posAtDOM(dom.focusNode, dom.focusOffset));
    const found = TextSelection.between(anchor, head);
    return found instanceof TextSelection ? found : null;
  } catch {
    return null;
  }
}

/** A keystroke's change as a transaction (typed text, or a character deleted), or null. */
function typedChange(state: EditorState, event: InputEvent): Transaction | null {
  const { selection, tr } = state;
  if (!(selection instanceof TextSelection)) return null;
  const { $from, from, to } = selection;
  if (event.inputType === 'insertText' && event.data) return tr.insertText(event.data);
  const back = event.inputType === 'deleteContentBackward';
  if (!back && event.inputType !== 'deleteContentForward') return null;
  if (from !== to) return tr.deleteSelection();
  // One character within the paragraph (both halves of a surrogate pair); at its edges,
  // the keymap and the browser decide (joining blocks is refused anyway).
  const text = $from.parent.textBetween(0, $from.parent.content.size, '', '\ufffc');
  const at = $from.parentOffset;
  if (back ? at === 0 : at >= text.length) return null;
  const low = (index: number) => /[\udc00-\udfff]/.test(text.charAt(index));
  if (back) return tr.delete(from - (at > 1 && low(at - 1) ? 2 : 1), from);
  return tr.delete(from, from + (low(at + 1) ? 2 : 1));
}

/**
 * A change typed in suggest mode, as a suggestion: text inserted, deleted, or a selection
 * replaced, inside text. Anything else (structure) is refused. Returns where the caret
 * goes (or null to leave it).
 */
function suggest(
  view: EditorView,
  tr: Transaction,
  host: EditorComments,
): number | null | 'refused' {
  if (tr.steps.length !== 1 || !(tr.steps[0] instanceof ReplaceStep)) return 'refused';
  const { from, to, slice } = tr.steps[0] as ReplaceStep;
  const state = view.state;
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  if (!$from.parent.isTextblock || !$from.sameParent($to)) return 'refused';
  let textOnly = true;
  slice.content.forEach((n) => (textOnly &&= n.isText));
  if (!textOnly || slice.openStart > 0 || slice.openEnd > 0) return 'refused';
  const insert = slice.content.textBetween(0, slice.content.size);

  if (from === to) {
    // Typing: onto the end of my suggestion here, or a new one.
    const mine = mineAt(state, host, from, 'end');
    if (mine) {
      host.updateSuggestion(mine.thread.id, { insert: mine.thread.suggestion!.insert + insert });
    } else {
      const anchor = anchorFor(state, from, from);
      if (anchor) host.createSuggestion(anchor, insert);
    }
    return null;
  }
  if (!insert) {
    // Deleting. Backspace into my suggested text takes it back first.
    const mine = mineAt(state, host, to, 'end');
    if (mine && mine.thread.suggestion!.insert && to - from === 1) {
      const rest = mine.thread.suggestion!.insert.slice(0, -1);
      if (!rest && mine.to === mine.from) host.dropSuggestion(mine.thread.id);
      else host.updateSuggestion(mine.thread.id, { insert: rest });
      return null;
    }
    // Next to my deletion: it grows.
    const before = mineAt(state, host, to, 'start');
    const after = mine ?? mineAt(state, host, from, 'end');
    const grow = before ?? after;
    if (grow) {
      const a = Math.min(from, grow.from);
      const b = Math.max(to, grow.to);
      const anchor = anchorFor(state, a, b);
      if (anchor) host.updateSuggestion(grow.thread.id, { anchor });
      return from;
    }
    const anchor = anchorFor(state, from, to);
    if (anchor) host.createSuggestion(anchor, '');
    return from;
  }
  // Replacing a selection.
  const anchor = anchorFor(state, from, to);
  if (anchor) host.createSuggestion(anchor, insert);
  return to;
}

export interface CommentsOptions {
  host: EditorComments | null;
}

export const Comments = Extension.create<CommentsOptions>({
  name: 'comments',
  addOptions() {
    return { host: null };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-m': ({ editor }) => {
        const host = this.options.host;
        const { from, to } = editor.state.selection;
        if (!host || from === to) return false;
        const anchor = anchorFor(editor.state, from, to);
        if (!anchor) return true;
        editor.commands.setTextSelection(to);
        host.comment(anchor);
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const host = this.options.host;
    if (!host) return [];
    let view: EditorView | null = null;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorations(state, host),
          // Anchors resolve through Yjs, which has a local edit only after this runs (the
          // sync plugin writes it on view update): local edits map the decorations, while
          // changes from Yjs (others' edits) and thread changes recompute them.
          apply: (tr, set, _old, state) =>
            tr.getMeta(REFRESH) || tr.getMeta(ySyncPluginKey)
              ? decorations(state, host)
              : set.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (state) => key.getState(state),
          handleDOMEvents: {
            // Suggest mode: typing never touches the DOM. Read back from the DOM, a refused
            // keystroke would linger there and the next one could be taken first.
            beforeinput: (v, event) => {
              if (!host.suggesting() || event.isComposing) return false;
              const caret = domSelection(v);
              if (caret && !caret.eq(v.state.selection)) {
                v.dispatch(v.state.tr.setSelection(caret));
              }
              const tr = typedChange(v.state, event);
              if (!tr) return false;
              event.preventDefault();
              v.dispatch(tr);
              return true;
            },
          },
          handleClick: (_view, _pos, event) => {
            const el = (event.target as HTMLElement | null)?.closest?.('[data-thread]');
            const id = el?.getAttribute('data-thread');
            if (!id) return false;
            host.open(id);
            return false;
          },
        },
        // Suggest mode: local edits become suggestions (remote ones and accepting go through).
        filterTransaction: (tr) => {
          if (!tr.docChanged || !view || !host.suggesting()) return true;
          if (tr.getMeta(APPLY_SUGGESTION) || tr.getMeta(ySyncPluginKey)) return true;
          const result = suggest(view, tr, host);
          if (result !== 'refused' && result !== null) {
            const caret = result;
            const v = view;
            queueMicrotask(() => {
              if (v.isDestroyed) return;
              const pos = Math.min(caret, v.state.doc.content.size);
              v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
            });
          }
          return false;
        },
        view: (v) => {
          view = v;
          const off = host.subscribe(() => {
            if (!v.isDestroyed) v.dispatch(v.state.tr.setMeta(REFRESH, true));
          });
          return {
            destroy: () => {
              off();
              view = null;
            },
          };
        },
      }),
    ];
  },
});

/**
 * Other people's cursors and selections in the editor (Phase 5 presence): y-tiptap's
 * cursor plugin over the page's awareness, with a name label in each person's color.
 */
import { yCursorPlugin } from '@tiptap/y-tiptap';
import type { Awareness } from 'y-protocols/awareness';

interface CursorUser {
  id?: string;
  name?: string;
  color?: string;
}

function caret(user: CursorUser): HTMLElement {
  const color = user.color ?? '#888';
  const caretEl = document.createElement('span');
  caretEl.className = 'ws-cursor';
  caretEl.style.borderColor = color;
  caretEl.dataset.userId = user.id ?? '';
  caretEl.dataset.testid = 'remote-cursor';
  const label = document.createElement('span');
  label.className = 'ws-cursor-label';
  label.style.backgroundColor = color;
  label.textContent = user.name ?? 'Someone';
  caretEl.append(label);
  return caretEl;
}

/**
 * The cursor plugin for an awareness (registered on a live editor when presence arrives,
 * so the editor isn't rebuilt). `selfId`: this person's other windows show no cursor.
 */
export function cursorsPlugin(awareness: Awareness, selfId: string | null) {
  return yCursorPlugin(awareness, {
    awarenessStateFilter: (current: number, client: number, state: { user?: CursorUser }) =>
      current !== client && !!state.user && state.user.id !== selfId,
    cursorBuilder: (user: CursorUser) => caret(user),
    selectionBuilder: (user: CursorUser) => ({
      style: `background-color: ${user.color ?? '#888'}33`,
      class: 'ws-remote-selection',
    }),
  });
}

export { yCursorPluginKey as cursorsPluginKey } from '@tiptap/y-tiptap';

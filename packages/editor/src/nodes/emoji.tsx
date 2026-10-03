import { Extension } from '@tiptap/core';
import { emojis, type EmojiItem } from '@tiptap/extension-emoji';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';
import { forwardRef } from 'react';
import {
  floatingList,
  type SuggestionListHandle,
  type SuggestionListProps,
} from '../suggestions/floating';
import { ItemList } from '../suggestions/item-list';

/** Emoji that have a character, minus the bare regional-indicator letters. */
export const EMOJI: EmojiItem[] = emojis.filter(
  (e) => e.emoji && !e.name.startsWith('regional_indicator'),
);

const MAX_RESULTS = 30;

/**
 * Rank emoji for ":query": exact shortcode, shortcode prefix, shortcode word prefix
 * ("smile" in "big_smile"), tag prefix, then substring.
 */
export function searchEmoji(query: string, list: readonly EmojiItem[] = EMOJI): EmojiItem[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const score = (e: EmojiItem): number => {
    if (e.shortcodes.includes(q)) return 5;
    if (e.shortcodes.some((s) => s.startsWith(q))) return 4;
    if (e.shortcodes.some((s) => s.split(/[_-]/).some((w) => w.startsWith(q)))) return 3;
    if (e.tags.some((t) => t.startsWith(q))) return 2;
    if (e.shortcodes.some((s) => s.includes(q))) return 1;
    return 0;
  };
  // Among equal scores, prefer the emoji whose matching shortcode is shortest.
  const closeness = (e: EmojiItem) =>
    Math.min(...e.shortcodes.filter((s) => s.includes(q)).map((s) => s.length), 99);
  return list
    .map((e, index) => ({ e, index, score: score(e), closeness: closeness(e) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.closeness - b.closeness || a.index - b.index)
    .slice(0, MAX_RESULTS)
    .map((r) => r.e);
}

const EmojiList = forwardRef<SuggestionListHandle<EmojiItem>, SuggestionListProps<EmojiItem>>(
  function EmojiList({ items, command, loading }, ref) {
    return (
      <ItemList<EmojiItem>
        ref={ref}
        items={items}
        loading={loading}
        command={command}
        label="Emoji"
        emptyText="No emoji found"
        keyOf={(e) => e.name}
        className="w-64"
        renderItem={(e) => (
          <>
            <span className="w-5 text-center text-base leading-none">{e.emoji}</span>
            <span className="truncate text-muted">:{e.shortcodes[0]}:</span>
          </>
        )}
      />
    );
  },
);

export const emojiKey = new PluginKey('emojiSuggest');

/** ":rock" suggests 🚀 and friends; choosing one inserts the plain character, as in Notion. */
export const EmojiSuggest = Extension.create({
  name: 'emojiSuggest',
  addProseMirrorPlugins() {
    return [
      Suggestion<EmojiItem, EmojiItem>({
        editor: this.editor,
        pluginKey: emojiKey,
        char: ':',
        allow: ({ editor }) => !editor.isActive('codeBlock'),
        // Wait for a letter after ":" before showing anything. (Returning false from
        // `allow` instead would dismiss the suggestion for good at the bare ":".)
        shouldShow: ({ query }) => query.length >= 1,
        items: ({ query }) => searchEmoji(query),
        command: ({ editor, range, props }) => {
          editor.chain().focus().insertContentAt(range, props.emoji!).run();
        },
        render: floatingList<EmojiItem>(EmojiList, {
          testId: 'emoji-menu',
          shouldExit: (props) => props.items.length === 0 && props.query.length > 2,
          exit: (props) => exitSuggestion(props.editor.view, emojiKey),
        }),
      }),
    ];
  },
});

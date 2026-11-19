import { Extension, type Editor } from '@tiptap/core';
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

/** A custom emoji in the menu: `fallbackImage` is its image's address. */
export type EmojiPick = EmojiItem & { custom?: { name: string; fileId: string } };

let standardNames: Set<string> | null = null;
/** Is this a built-in emoji's shortcode? (A custom emoji can't take one.) */
export function isStandardEmoji(name: string): boolean {
  standardNames ??= new Set(EMOJI.flatMap((e) => e.shortcodes));
  return standardNames.has(name);
}

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

const EmojiList = forwardRef<SuggestionListHandle<EmojiPick>, SuggestionListProps<EmojiPick>>(
  function EmojiList({ items, command, loading }, ref) {
    return (
      <ItemList<EmojiPick>
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
            {e.custom ? (
              <img className="size-5 object-contain" src={e.fallbackImage} alt="" />
            ) : (
              <span className="w-5 text-center text-base leading-none">{e.emoji}</span>
            )}
            <span className="truncate text-muted">:{e.shortcodes[0]}:</span>
          </>
        )}
      />
    );
  },
);

export const emojiKey = new PluginKey('emojiSuggest');

/** The workspace's custom emoji, as menu items. */
function customPicks(editor: Editor): EmojiPick[] {
  const services = editor.storage.uiBridge?.ref.current.services;
  return (services?.customEmoji?.list() ?? []).map((e) => ({
    name: `custom:${e.name}`,
    shortcodes: [e.name],
    tags: ['custom'],
    group: 'custom',
    fallbackImage: services!.fileUrl(e.fileId),
    custom: e,
  }));
}

/** Where `/emoji` typed a ":": its menu shows before a letter is typed. */
const openedAt = new WeakMap<Editor, number>();
/** Shown for a bare ":" opened by `/emoji`. */
const FIRST = EMOJI.slice(0, MAX_RESULTS);

/** Open the emoji menu at the cursor (`/emoji`). */
export function openEmojiMenu(editor: Editor): void {
  const { $from, from } = editor.state.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const spaced = before !== '' && !/\s$/.test(before);
  // Known before the ":" goes in: the menu decides whether to show as it does.
  openedAt.set(editor, from + (spaced ? 1 : 0));
  editor
    .chain()
    .focus()
    .insertContent(spaced ? ' :' : ':')
    .run();
}

/**
 * ":rock" suggests 🚀 and friends; choosing one inserts the plain character, as in Notion.
 * The workspace's custom emoji come first, and go in as a `customEmoji` node.
 */
export const EmojiSuggest = Extension.create({
  name: 'emojiSuggest',
  addProseMirrorPlugins() {
    return [
      Suggestion<EmojiPick, EmojiPick>({
        editor: this.editor,
        pluginKey: emojiKey,
        char: ':',
        allow: ({ editor }) => !editor.isActive('codeBlock'),
        // Wait for a letter after ":" before showing anything. (Returning false from
        // `allow` instead would dismiss the suggestion for good at the bare ":".)
        shouldShow: ({ editor, range, query }) =>
          query.length >= 1 || openedAt.get(editor) === range.from,
        items: ({ editor, query }) => {
          const custom = customPicks(editor);
          return query
            ? [...searchEmoji(query, custom), ...searchEmoji(query)].slice(0, MAX_RESULTS)
            : [...custom, ...FIRST].slice(0, MAX_RESULTS);
        },
        command: ({ editor, range, props }) => {
          const content = props.custom
            ? {
                type: 'customEmoji',
                attrs: { name: props.custom.name, fileId: props.custom.fileId },
              }
            : props.emoji!;
          editor.chain().focus().insertContentAt(range, content).run();
        },
        render: floatingList<EmojiPick>(EmojiList, {
          testId: 'emoji-menu',
          shouldExit: (props) => props.items.length === 0 && props.query.length > 2,
          exit: (props) => exitSuggestion(props.editor.view, emojiKey),
        }),
      }),
    ];
  },
});

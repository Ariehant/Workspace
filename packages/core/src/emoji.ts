import type * as Y from 'yjs';

/**
 * Custom emoji (Phase 8 N8, #7): images uploaded under a name, used as `:name:` anywhere
 * emoji are. Kept in the workspace's data doc (see `workspaceDataDoc`), so everyone in the
 * workspace has them, offline too.
 */
const CUSTOM_EMOJI = 'customEmoji';

export interface CustomEmoji {
  name: string;
  /** The uploaded image's file id. */
  fileId: string;
  /** Who added it. */
  by: string | null;
  at: number;
}

/** A name: lowercase letters, digits, `_` and `-`, up to 32 of them. */
export const CUSTOM_EMOJI_NAME = /^[a-z0-9_-]{1,32}$/;

const emojiMap = (doc: Y.Doc) => doc.getMap<unknown>(CUSTOM_EMOJI);

function read(name: string, value: unknown): CustomEmoji | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<CustomEmoji>;
  if (typeof v.fileId !== 'string' || !CUSTOM_EMOJI_NAME.test(name)) return null;
  return {
    name,
    fileId: v.fileId,
    by: typeof v.by === 'string' ? v.by : null,
    at: typeof v.at === 'number' ? v.at : 0,
  };
}

/** Every custom emoji, by name. */
export function listCustomEmoji(doc: Y.Doc): CustomEmoji[] {
  return [...emojiMap(doc).entries()]
    .flatMap(([name, value]) => {
      const emoji = read(name, value);
      return emoji ? [emoji] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getCustomEmoji(doc: Y.Doc, name: string): CustomEmoji | null {
  return read(name, emojiMap(doc).get(name));
}

/**
 * Why a name can't be used, or null when it can. `standard` tells the built-in shortcodes
 * (a custom emoji can't hide one).
 */
export function customEmojiNameProblem(
  doc: Y.Doc,
  name: string,
  standard: (name: string) => boolean = () => false,
): string | null {
  if (!CUSTOM_EMOJI_NAME.test(name)) {
    return 'Use lowercase letters, numbers, - and _ (up to 32)';
  }
  if (standard(name)) return `:${name}: is already an emoji`;
  if (emojiMap(doc).has(name)) return `:${name}: is taken`;
  return null;
}

/** Add one; throws when the name can't be used. */
export function addCustomEmoji(
  doc: Y.Doc,
  emoji: { name: string; fileId: string; by: string | null; at?: number },
  standard?: (name: string) => boolean,
): void {
  const problem = customEmojiNameProblem(doc, emoji.name, standard);
  if (problem) throw new Error(problem);
  emojiMap(doc).set(emoji.name, { fileId: emoji.fileId, by: emoji.by, at: emoji.at ?? Date.now() });
}

export function removeCustomEmoji(doc: Y.Doc, name: string): void {
  emojiMap(doc).delete(name);
}

/** Call `listener` whenever the custom emoji change. */
export function observeCustomEmoji(doc: Y.Doc, listener: () => void): () => void {
  const map = emojiMap(doc);
  const onChange = () => listener();
  map.observe(onChange);
  return () => map.unobserve(onChange);
}

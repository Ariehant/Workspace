import type * as Y from 'yjs';

/**
 * Linked files (Phase 8 N9): a page points at a file on the computer instead of holding a
 * copy. A pointer names a linked folder ("Projects") and a path inside it, so it opens on
 * every computer that links a folder under that name (a synced Dropbox, Syncthing or git
 * folder), or else holds the file's full path on the computer it was made on.
 *
 * The folder names are the workspace's (kept in its data doc, see `workspaceDataDoc`); where
 * each one is on a computer is that computer's own setting.
 */
const LINKED_FOLDERS = 'linkedFolders';

/** A pointer to a file, as a block keeps it. */
export interface LinkedFileRef {
  /** A linked folder's name, or null for a full path on one computer. */
  folder: string | null;
  /** Inside the folder: its parts joined with `/`. Without one: the full path. */
  path: string;
  name: string;
  /** When it was linked (or located again): its size and when it last changed. */
  size: number | null;
  modifiedAt: number | null;
}

/** What a linked file is on this computer now. */
export type LinkedFileStatus =
  | {
      state: 'found';
      size: number | null;
      modifiedAt: number;
      /** It's a folder. */
      folder: boolean;
      /** An image the page can show. */
      preview: boolean;
    }
  | { state: 'missing' }
  /** Its linked folder isn't linked on this computer. */
  | { state: 'noFolder' };

export interface LinkedFolder {
  name: string;
  /** Who added it. */
  by: string | null;
  at: number;
}

/** A folder name: letters, digits, spaces, `_`, `.` and `-`, up to 40, not starting with a dot. */
export const LINKED_FOLDER_NAME = /^[\p{L}\p{N}_-][\p{L}\p{N} _.-]{0,39}$/u;

const folderMap = (doc: Y.Doc) => doc.getMap<unknown>(LINKED_FOLDERS);

function read(name: string, value: unknown): LinkedFolder | null {
  if (!value || typeof value !== 'object' || !LINKED_FOLDER_NAME.test(name)) return null;
  const v = value as Partial<LinkedFolder>;
  return {
    name,
    by: typeof v.by === 'string' ? v.by : null,
    at: typeof v.at === 'number' ? v.at : 0,
  };
}

/** The workspace's linked folders, by name. */
export function listLinkedFolders(doc: Y.Doc): LinkedFolder[] {
  return [...folderMap(doc).entries()]
    .flatMap(([name, value]) => {
      const folder = read(name, value);
      return folder ? [folder] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Why a name can't be used for a new folder, or null when it can. */
export function linkedFolderNameProblem(doc: Y.Doc, name: string): string | null {
  if (!LINKED_FOLDER_NAME.test(name) || name.trim() !== name) {
    return 'Use letters, numbers, spaces, ., - and _ (up to 40)';
  }
  const taken = [...folderMap(doc).keys()].some((n) => n.toLowerCase() === name.toLowerCase());
  return taken ? `“${name}” is already a linked folder` : null;
}

/** Add a folder name; throws when it can't be used. */
export function addLinkedFolder(doc: Y.Doc, name: string, by: string | null): void {
  const problem = linkedFolderNameProblem(doc, name);
  if (problem) throw new Error(problem);
  folderMap(doc).set(name, { by, at: Date.now() });
}

/** Remove a folder name (pointers into it then show as not found until it's added again). */
export function removeLinkedFolder(doc: Y.Doc, name: string): void {
  folderMap(doc).delete(name);
}

/** Call `listener` whenever the linked folders change. */
export function observeLinkedFolders(doc: Y.Doc, listener: () => void): () => void {
  const map = folderMap(doc);
  const onChange = () => listener();
  map.observe(onChange);
  return () => map.unobserve(onChange);
}

/**
 * A path inside a linked folder as its parts, or null when it could leave the folder (`..`),
 * is absolute, or is empty. Both `/` and `\` separate parts.
 */
export function relativeParts(path: string): string[] | null {
  if (!path || path.length > 4096 || path.includes('\0')) return null;
  if (/^[/\\]/.test(path) || /^[a-zA-Z]:/.test(path)) return null;
  const parts = path.split(/[/\\]+/).filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return null;
  return parts;
}

/**
 * The path of `file` inside `folder` (both full paths on one computer, with `sep` between
 * parts), joined with `/`; null when it isn't inside.
 */
export function pathInFolder(folder: string, file: string, sep: '/' | '\\'): string | null {
  const trim = (p: string) => (p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p);
  const root = trim(folder);
  const fold = (p: string) => (sep === '\\' ? p.toLowerCase() : p);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!fold(file).startsWith(fold(prefix))) return null;
  const parts = relativeParts(file.slice(prefix.length));
  return parts ? parts.join('/') : null;
}

/** A pointer as a block's attributes hold it, or null when they don't make one. */
export function linkedFileOf(attrs: Record<string, unknown> | undefined): LinkedFileRef | null {
  if (!attrs || typeof attrs.path !== 'string' || attrs.path === '') return null;
  const folder =
    typeof attrs.folder === 'string' && LINKED_FOLDER_NAME.test(attrs.folder) ? attrs.folder : null;
  if (folder && !relativeParts(attrs.path)) return null;
  const name =
    typeof attrs.name === 'string' && attrs.name
      ? attrs.name
      : (attrs.path.split(/[/\\]/).pop() ?? attrs.path);
  const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    folder,
    path: attrs.path,
    name,
    size: number(attrs.size),
    modifiedAt: number(attrs.modifiedAt),
  };
}

/** Where a pointer points, for people: "Projects/arm/v3.step" or the full path. */
export function linkedFileLocation(ref: LinkedFileRef): string {
  return ref.folder ? `${ref.folder}/${ref.path}` : ref.path;
}

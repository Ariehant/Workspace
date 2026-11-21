/**
 * Linked files (Phase 8 N9): pointers to files on this computer, kept in pages instead of
 * copies. The pages hold a linked folder's name and a path inside it (or a full path); where
 * each folder is on this computer is this computer's setting, kept here in the main process
 * (the UI can't change it, so a pointer can't be steered out of its folder).
 *
 * Pointers come from pages other people can edit, so nothing opens on its own: a file opens
 * when it's clicked, and a program or script only after the person confirms it here.
 */
import { constants, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LINKED_FOLDER_NAME,
  linkedFileOf,
  previewKindOf,
  pathInFolder,
  relativeParts,
  type LinkedFileRef,
} from '@workspace/core';
import type { SqliteStore } from '@workspace/storage-local';
import { BrowserWindow, dialog, ipcMain, net, shell, type OpenDialogOptions } from 'electron';
import { IPC, type LinkedFileStatus } from '../shared/ipc';

/** This computer's folders, by name. Not readable or writable through the settings IPC. */
export const LINKED_FOLDERS_SETTING = 'linkedFolders';

/**
 * `ws-file://linked/?ref=…` serves a linked file the page can preview (images, PDFs, Word
 * documents and Excel workbooks); nothing else.
 */
export const LINKED_PREVIEW_HOST = 'linked';
const PREVIEW_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

/** Opening these runs them: asked first. */
const PROGRAMS = new Set([
  '.appimage',
  '.bat',
  '.bin',
  '.cmd',
  '.com',
  '.command',
  '.cpl',
  '.deb',
  '.desktop',
  '.exe',
  '.jar',
  '.js',
  '.jse',
  '.lnk',
  '.msi',
  '.pl',
  '.ps1',
  '.py',
  '.rb',
  '.rpm',
  '.run',
  '.scr',
  '.sh',
  '.vbs',
  '.wsf',
]);

type Folders = Record<string, string>;

function readFolders(store: SqliteStore): Folders {
  const raw = store.getSetting<unknown>(LINKED_FOLDERS_SETTING);
  const folders: Folders = {};
  if (!raw || typeof raw !== 'object') return folders;
  for (const [name, path] of Object.entries(raw as Record<string, unknown>)) {
    if (LINKED_FOLDER_NAME.test(name) && typeof path === 'string' && isAbsolute(path)) {
      folders[name] = path;
    }
  }
  return folders;
}

type Located = { path: string } | { problem: 'noFolder' | 'invalid' };

/** Where a pointer is on this computer. */
export function locate(ref: LinkedFileRef, folders: Folders): Located {
  if (ref.folder === null) {
    return isAbsolute(ref.path) ? { path: resolve(ref.path) } : { problem: 'invalid' };
  }
  const root = folders[ref.folder];
  if (!root) return { problem: 'noFolder' };
  const parts = relativeParts(ref.path);
  if (!parts) return { problem: 'invalid' };
  const full = resolve(root, ...parts);
  const inside = relative(root, full);
  const outside = inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  if (!inside || outside) return { problem: 'invalid' };
  return { path: full };
}

/** A pointer to `file`: inside the deepest linked folder that holds it, else its full path. */
export function pointerTo(file: string, info: Stats, folders: Folders): LinkedFileRef {
  let best: { folder: string; path: string; depth: number } | null = null;
  for (const [folder, root] of Object.entries(folders)) {
    const path = pathInFolder(root, file, sep as '/' | '\\');
    if (path !== null && (!best || root.length > best.depth)) {
      best = { folder, path, depth: root.length };
    }
  }
  const name = file.split(sep).pop() ?? file;
  return {
    folder: best?.folder ?? null,
    path: best?.path ?? file,
    name,
    size: info.size,
    modifiedAt: Math.round(info.mtimeMs),
  };
}

function isProgram(path: string, info: Stats): boolean {
  if (PROGRAMS.has(extname(path).toLowerCase())) return true;
  return process.platform !== 'win32' && info.isFile() && (info.mode & constants.S_IXUSR) !== 0;
}

async function statOf(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** Serve a linked file the page previews (`ws-file://linked/?ref=…`); other files aren't. */
export async function linkedPreview(store: SqliteStore, url: URL): Promise<Response> {
  let ref: LinkedFileRef | null;
  try {
    ref = linkedFileOf(JSON.parse(url.searchParams.get('ref') ?? '') as Record<string, unknown>);
  } catch {
    ref = null;
  }
  const where = ref ? locate(ref, readFolders(store)) : null;
  const type = where && 'path' in where ? PREVIEW_TYPES[extname(where.path).toLowerCase()] : null;
  if (!where || !('path' in where) || !type) return new Response('Not found', { status: 404 });
  const info = await statOf(where.path);
  if (!info?.isFile() || info.size > MAX_PREVIEW_BYTES) {
    return new Response('Not found', { status: 404 });
  }
  const response = await net.fetch(pathToFileURL(where.path).href);
  const headers = new Headers({ 'content-type': type, 'access-control-allow-origin': '*' });
  return new Response(response.body, { status: response.status, headers });
}

/** Handle the linked-file IPC. Call after ready. */
export function registerLinkedFiles(store: SqliteStore): void {
  const windowOf = (sender: Electron.WebContents) => BrowserWindow.fromWebContents(sender);
  const refOf = (value: unknown) =>
    value && typeof value === 'object' ? linkedFileOf(value as Record<string, unknown>) : null;

  // Pick files to link (`one`: to locate a moved file).
  ipcMain.handle(IPC.linkedPick, async (event, one: unknown) => {
    const options: OpenDialogOptions = {
      title: one ? 'Locate the file' : 'Link files',
      buttonLabel: one ? 'Locate' : 'Link',
      properties: one ? ['openFile'] : ['openFile', 'multiSelections'],
    };
    const window = windowOf(event.sender);
    const { canceled, filePaths } = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (canceled) return [];
    const folders = readFolders(store);
    const picked: LinkedFileRef[] = [];
    for (const file of filePaths) {
      const info = await statOf(file);
      if (info) picked.push(pointerTo(file, info, folders));
    }
    return picked;
  });

  ipcMain.handle(IPC.linkedStatus, async (_event, raw: unknown): Promise<LinkedFileStatus> => {
    const ref = refOf(raw);
    if (!ref) return { state: 'missing' };
    const where = locate(ref, readFolders(store));
    if ('problem' in where) {
      return where.problem === 'noFolder' ? { state: 'noFolder' } : { state: 'missing' };
    }
    const info = await statOf(where.path);
    if (!info) return { state: 'missing' };
    return {
      state: 'found',
      size: info.isFile() ? info.size : null,
      modifiedAt: Math.round(info.mtimeMs),
      folder: info.isDirectory(),
      preview: info.isFile() && info.size <= MAX_PREVIEW_BYTES ? previewKindOf(where.path) : null,
    };
  });

  // Open with the default app (a program or script only once confirmed).
  ipcMain.handle(IPC.linkedOpen, async (event, raw: unknown) => {
    const ref = refOf(raw);
    const where = ref ? locate(ref, readFolders(store)) : null;
    if (!where || !('path' in where)) return false;
    const info = await statOf(where.path);
    if (!info) return false;
    if (isProgram(where.path, info)) {
      const ask = {
        type: 'warning' as const,
        // The file's own name, not the one the page gives it.
        message: `“${basename(where.path)}” is a program or script`,
        detail: `Opening it runs it on this computer:\n${where.path}\n\nOpen it only if you trust where it came from.`,
        buttons: ['Cancel', 'Run it'],
        defaultId: 0,
        cancelId: 0,
      };
      const window = windowOf(event.sender);
      const { response } = window
        ? await dialog.showMessageBox(window, ask)
        : await dialog.showMessageBox(ask);
      if (response !== 1) return false;
    }
    return (await shell.openPath(where.path)) === '';
  });

  ipcMain.handle(IPC.linkedReveal, async (_event, raw: unknown) => {
    const ref = refOf(raw);
    const where = ref ? locate(ref, readFolders(store)) : null;
    if (!where || !('path' in where) || !(await statOf(where.path))) return false;
    shell.showItemInFolder(where.path);
    return true;
  });

  // This computer's folders.
  ipcMain.handle(IPC.linkedFolders, () => readFolders(store));

  ipcMain.handle(IPC.linkedFolderChoose, async (event, name: unknown) => {
    if (typeof name !== 'string' || !LINKED_FOLDER_NAME.test(name)) return null;
    const options: OpenDialogOptions = {
      title: `Where is “${name}” on this computer?`,
      buttonLabel: 'Link folder',
      properties: ['openDirectory', 'createDirectory'],
    };
    const window = windowOf(event.sender);
    const { canceled, filePaths } = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const path = filePaths[0];
    if (canceled || !path) return null;
    store.setSetting(LINKED_FOLDERS_SETTING, { ...readFolders(store), [name]: resolve(path) });
    return resolve(path);
  });

  ipcMain.handle(IPC.linkedFolderForget, (_event, name: unknown) => {
    if (typeof name !== 'string') return;
    const { [name]: _gone, ...rest } = readFolders(store);
    store.setSetting(LINKED_FOLDERS_SETTING, rest);
  });
}

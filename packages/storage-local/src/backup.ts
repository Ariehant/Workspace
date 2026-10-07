import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import { isFileId } from './file-store';
import { isSyncSetting, type FileRecord, type SqliteStore } from './sqlite-store';

/** Identifies a workspace backup's manifest. */
export const BACKUP_FORMAT = 'workspace-backup';
export const BACKUP_VERSION = 1;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: number;
  /** Ids of the docs under `docs/`. */
  docs: string[];
  /** Records of the files under `files/`. */
  files: FileRecord[];
}

export interface BackupEntry {
  path: string;
  data: Uint8Array;
}

const encoder = new TextEncoder();
const docPath = (id: string) => `docs/${encodeURIComponent(id)}.ydoc`;

/**
 * A lossless backup of a workspace: every doc's full Yjs state, the stored files and
 * the settings, with a manifest. (Page history versions aren't included.)
 */
export function* backupEntries(
  store: SqliteStore,
  filesDir: string,
  onProgress?: (done: number, total: number) => void,
): Generator<BackupEntry> {
  const docs = store.listDocIds();
  const files = store
    .listFileRecords()
    .filter((f) => isFileId(f.id) && existsSync(join(filesDir, f.id)));
  const total = docs.length + files.length;
  let done = 0;
  for (const id of docs) {
    const updates = store.getUpdates(id);
    if (updates.length === 0) continue;
    yield { path: docPath(id), data: Y.mergeUpdates(updates) };
    onProgress?.(++done, total);
  }
  for (const file of files) {
    yield { path: `files/${file.id}`, data: readFileSync(join(filesDir, file.id)) };
    onProgress?.(++done, total);
  }
  yield { path: 'settings.json', data: encoder.encode(JSON.stringify(store.listSettings())) };
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    docs,
    files,
  };
  yield { path: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) };
}

/** The manifest of a backup's entries, or an error saying why it isn't one. */
export function readBackupManifest(entries: ReadonlyMap<string, Uint8Array>): BackupManifest {
  const raw = entries.get('manifest.json');
  if (!raw) throw new Error('This file is not a workspace backup (no manifest).');
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as Partial<BackupManifest>;
  if (manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.docs)) {
    throw new Error('This file is not a workspace backup.');
  }
  if ((manifest.version ?? 0) > BACKUP_VERSION) {
    throw new Error('This backup was made by a newer version of the app.');
  }
  return manifest as BackupManifest;
}

/**
 * Restore a backup into an empty store and files folder. Search and links aren't in
 * the backup: rebuild them afterwards (`DocManager.reindexAll`).
 */
export function restoreBackup(
  entries: ReadonlyMap<string, Uint8Array>,
  store: SqliteStore,
  filesDir: string,
): { docs: number; files: number } {
  const manifest = readBackupManifest(entries);
  if (store.listDocIds().length > 0) throw new Error('Backups restore into an empty workspace.');
  let docs = 0;
  let files = 0;
  // (Each doc is written in its own transaction.)
  {
    for (const id of manifest.docs) {
      const state = entries.get(docPath(id));
      if (!state) continue;
      store.replaceUpdates(id, state);
      docs++;
    }
    for (const record of manifest.files ?? []) {
      const bytes = entries.get(`files/${record.id}`);
      if (!bytes || !isFileId(record.id)) continue;
      writeFileSync(join(filesDir, record.id), bytes);
      store.putFileRecord(record);
      files++;
    }
    const settings = entries.get('settings.json');
    if (settings) {
      const values = JSON.parse(new TextDecoder().decode(settings)) as Record<string, unknown>;
      for (const [key, value] of Object.entries(values)) {
        // Older backups may carry another device's sync state: never restore it.
        if (!isSyncSetting(key)) store.setSetting(key, value);
      }
    }
  }
  return { docs, files };
}

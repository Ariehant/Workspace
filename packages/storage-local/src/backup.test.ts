import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_DOC_ID, createPage, getPage, getPageContent } from '@workspace/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  DocManager,
  FileStore,
  SqliteStore,
  backupEntries,
  readBackupManifest,
  restoreBackup,
} from './index';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-backup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function edit(manager: DocManager, docId: string, change: (doc: Y.Doc) => void) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, manager.open(docId));
  doc.on('update', (update: Uint8Array) => manager.applyUpdate(docId, update, 'test'));
  change(doc);
  manager.release(docId);
}

describe('workspace backup', () => {
  it('restores docs, files and settings into an empty workspace, then re-indexes', () => {
    const a = join(dir, 'a');
    mkdirSync(a);
    const store = new SqliteStore(join(a, 'workspace.db'));
    const manager = new DocManager(store);
    const files = new FileStore(a, store);
    const file = files.import(new TextEncoder().encode('png!'), 'arm.png', 'image/png');
    let pageId = '';
    edit(manager, WORKSPACE_DOC_ID, (ws) => {
      pageId = createPage(ws, { title: 'Gripper design' });
    });
    edit(manager, pageId, (doc) => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('Two finger parallel jaw')]);
      getPageContent(doc).insert(0, [p]);
    });
    store.setSetting('ui.theme', 'dark');
    manager.flush();

    const entries = new Map([...backupEntries(store, files.dir)].map((e) => [e.path, e.data]));
    expect(readBackupManifest(entries).docs).toEqual(
      expect.arrayContaining([WORKSPACE_DOC_ID, pageId]),
    );
    manager.close();
    store.close();

    const b = join(dir, 'b');
    mkdirSync(b);
    const restored = new SqliteStore(join(b, 'workspace.db'));
    const restoredFiles = new FileStore(b, restored);
    expect(restoreBackup(entries, restored, restoredFiles.dir)).toEqual({ docs: 2, files: 1 });
    // Byte for byte, at the Yjs level.
    for (const id of [WORKSPACE_DOC_ID, pageId]) {
      expect(Y.mergeUpdates(restored.getUpdates(id))).toEqual(
        entries.get(`docs/${encodeURIComponent(id)}.ydoc`),
      );
    }
    // Search isn't in the backup: it's rebuilt.
    expect(restored.search('parallel')).toHaveLength(0);
    const next = new DocManager(restored);
    next.reindexAll();
    expect(restored.search('parallel').map((r) => r.id)).toEqual([pageId]);
    expect(getPage(next.workspace, pageId)?.title).toBe('Gripper design');
    expect(readFileSync(restoredFiles.resolve(file.id)!, 'utf8')).toBe('png!');
    expect(restored.getFileRecord(file.id)?.name).toBe('arm.png');
    expect(restored.getSetting('ui.theme')).toBe('dark');
    // Only into an empty workspace.
    expect(() => restoreBackup(entries, restored, restoredFiles.dir)).toThrow(/empty/);
    expect(() => readBackupManifest(new Map())).toThrow(/not a workspace backup/);
    next.close();
    restored.close();
  });
});

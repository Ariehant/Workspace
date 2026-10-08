/**
 * Runs an import off the main thread: unpacks the files, stores attachments, and builds
 * the new pages' docs. The main thread applies the resulting updates, so open windows
 * and the search index see them like any other edit.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { getPagesMap } from '@workspace/core';
import { isDatabaseDoc } from '@workspace/database';
import { importFiles, type ArchiveFile, type ImportReport } from '@workspace/importers';
import { FileStore, SqliteStore } from '@workspace/storage-local';
import { unzipSync } from 'fflate';
import * as Y from 'yjs';

export interface ImportJob {
  dbPath: string;
  dataDir: string;
  paths: string[];
  title: string;
  /** The page tree the import goes into (the workspace doc, or a scope's tree). */
  tree: string;
}

export type ImportWorkerMessage =
  | { type: 'progress'; done: number; total: number }
  /** In the order to apply them: the workspace first, then databases, rows and pages. */
  | { type: 'docs'; docs: { id: string; update: Uint8Array }[]; report: ImportReport }
  | { type: 'error'; error: string };

const job = workerData as ImportJob;
const post = (message: ImportWorkerMessage) => parentPort!.postMessage(message);

/** Zip entries, with zips inside (Notion's `Part-1.zip`) unpacked in place. */
function unpack(bytes: Uint8Array, prefix = '', depth = 0): ArchiveFile[] {
  const out: ArchiveFile[] = [];
  for (const [path, data] of Object.entries(unzipSync(bytes))) {
    if (path.endsWith('/')) continue;
    if (/\.zip$/i.test(path) && depth < 3) out.push(...unpack(data, prefix, depth + 1));
    else out.push({ path: prefix + path, data });
  }
  return out;
}

function run(): void {
  const store = new SqliteStore(job.dbPath);
  try {
    const files = job.paths.flatMap((path): ArchiveFile[] => {
      const data = readFileSync(path);
      return /\.zip$/i.test(path) ? unpack(data) : [{ path: basename(path), data }];
    });
    const workspace = new Y.Doc();
    const updates = store.getUpdates(job.tree);
    if (updates.length) Y.applyUpdate(workspace, Y.mergeUpdates(updates));
    const before = Y.encodeStateVector(workspace);
    const docs = new Map<string, Y.Doc>();
    const fileStore = new FileStore(job.dataDir, store);
    const report = importFiles(
      files,
      {
        workspace,
        doc: (id) => {
          let doc = docs.get(id);
          if (!doc) docs.set(id, (doc = new Y.Doc()));
          return doc;
        },
        storeFile: (bytes, name, mime) => fileStore.import(bytes, name, mime).id,
      },
      {
        title: job.title,
        onProgress: (done, total) => post({ type: 'progress', done, total }),
      },
    );
    const pages = getPagesMap(workspace);
    const rank = (id: string, doc: Y.Doc) => (isDatabaseDoc(doc) ? 0 : pages.has(id) ? 2 : 1);
    const ordered = [...docs].sort(([a, x], [b, y]) => rank(a, x) - rank(b, y));
    post({
      type: 'docs',
      docs: [
        { id: job.tree, update: Y.encodeStateAsUpdate(workspace, before) },
        ...ordered.map(([id, doc]) => ({ id, update: Y.encodeStateAsUpdate(doc) })),
      ],
      report,
    });
  } catch (error) {
    post({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  } finally {
    store.close();
  }
}

run();

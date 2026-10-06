/**
 * Runs an export off the main thread: reads the docs straight from the workspace
 * database (its own connection; the main thread writes every update as it happens),
 * renders them and streams the files into a zip.
 */
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { WORKSPACE_DOC_ID, listUsers } from '@workspace/core';
import {
  exportPages,
  mermaidSources,
  type ExportOptions,
  type ExportSource,
} from '@workspace/exporters';
import { SqliteStore, backupEntries, isFileId } from '@workspace/storage-local';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import * as Y from 'yjs';

export interface ExportJob {
  dbPath: string;
  filesDir: string;
  outPath: string;
  kind: 'pages' | 'backup';
  options?: Omit<ExportOptions, 'mermaidSvg' | 'onProgress'>;
}

export type WorkerMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'mermaid'; sources: string[] }
  | { type: 'done' }
  | { type: 'error'; error: string };

const job = workerData as ExportJob;
const post = (message: WorkerMessage) => parentPort!.postMessage(message);

/** Text and already-compressed media are stored as they are; the rest is deflated. */
const COMPRESSED = /\.(png|jpe?g|gif|webp|avif|mp4|webm|mov|mp3|ogg|m4a|zip|gz|pdf|ydoc)$/i;

class ZipFile {
  private readonly zip: Zip;
  private readonly finished: Promise<void>;

  constructor(path: string) {
    const out = createWriteStream(path);
    this.finished = new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    this.zip = new Zip((error, chunk, final) => {
      if (error) {
        out.destroy(error);
        return;
      }
      out.write(chunk);
      if (final) out.end();
    });
  }

  add(path: string, data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const file = COMPRESSED.test(path)
      ? new ZipPassThrough(path)
      : new ZipDeflate(path, { level: 6 });
    this.zip.add(file);
    file.push(bytes, true);
  }

  close(): Promise<void> {
    this.zip.end();
    return this.finished;
  }
}

/** Mermaid SVGs from the main thread (rendered by a window), keyed by source. */
function askForDiagrams(sources: string[]): Promise<Map<string, string>> {
  if (sources.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    parentPort!.once('message', (message: { type: string; svgs?: Record<string, string> }) => {
      resolve(new Map(Object.entries(message.svgs ?? {})));
    });
    post({ type: 'mermaid', sources });
  });
}

async function run(): Promise<void> {
  const store = new SqliteStore(job.dbPath);
  const zip = new ZipFile(job.outPath);
  try {
    if (job.kind === 'backup') {
      for (const entry of backupEntries(store, job.filesDir, (done, total) =>
        post({ type: 'progress', done, total }),
      )) {
        zip.add(entry.path, entry.data);
      }
    } else {
      const docs = new Map<string, Y.Doc | null>();
      const doc = (id: string): Y.Doc | null => {
        if (!docs.has(id)) {
          const updates = store.getUpdates(id);
          let loaded: Y.Doc | null = null;
          if (updates.length > 0) {
            loaded = new Y.Doc();
            Y.applyUpdate(loaded, Y.mergeUpdates(updates));
          }
          docs.set(id, loaded);
        }
        return docs.get(id)!;
      };
      const workspace = doc(WORKSPACE_DOC_ID) ?? new Y.Doc();
      const source: ExportSource = {
        workspace,
        doc,
        file: (id) => {
          if (!isFileId(id)) return null;
          try {
            return {
              bytes: readFileSync(join(job.filesDir, id)),
              name: store.getFileRecord(id)?.name ?? null,
            };
          } catch {
            return null;
          }
        },
        users: new Map(listUsers(workspace).map((u) => [u.id, u.name])),
      };
      const options = job.options!;
      const svgs =
        options.format === 'html'
          ? await askForDiagrams(mermaidSources(source, options))
          : new Map<string, string>();
      for (const entry of exportPages(source, {
        ...options,
        mermaidSvg: (code) => svgs.get(code) ?? null,
        onProgress: (done, total) => post({ type: 'progress', done, total }),
      })) {
        zip.add(entry.path, entry.data);
      }
    }
    await zip.close();
    post({ type: 'done' });
  } catch (error) {
    post({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  } finally {
    store.close();
  }
}

void run();

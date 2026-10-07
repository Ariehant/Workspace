import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FileRecord, SqliteStore } from './sqlite-store';

/** Ids look like `<64 hex chars>.<ext>`; anything else is rejected before touching disk. */
const FILE_ID = /^[0-9a-f]{64}(\.[a-z0-9]{1,10})?$/;

export function isFileId(value: unknown): value is string {
  return typeof value === 'string' && FILE_ID.test(value);
}

function extensionFor(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? `.${ext}` : '';
}

/**
 * Attachments (images, videos, PDFs, any file) for one workspace, stored once per
 * content hash under `<dataDir>/files/`. Metadata lives in the `files` table.
 */
export class FileStore {
  readonly dir: string;

  constructor(
    dataDir: string,
    private readonly store: SqliteStore,
  ) {
    this.dir = join(dataDir, 'files');
    mkdirSync(this.dir, { recursive: true });
  }

  /** Store `bytes` and return the record. Importing the same content again is a no-op. */
  import(bytes: Uint8Array, name: string, mime: string): FileRecord {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const id = `${hash}${extensionFor(name)}`;
    const path = this.pathOf(id);
    if (!existsSync(path)) {
      // Write to a temp name first so a crash never leaves a truncated file under its id.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
    const record: FileRecord = {
      id,
      name: name.slice(0, 255) || 'Untitled',
      mime: mime || 'application/octet-stream',
      size: bytes.byteLength,
      createdAt: Date.now(),
    };
    this.store.putFileRecord(record);
    return this.store.getFileRecord(id) ?? record;
  }

  /**
   * Store bytes fetched for a known id (from the sync server): kept only if their hash
   * is the id's. Returns false when they don't match.
   */
  importAs(id: string, bytes: Uint8Array, name: string, mime: string): boolean {
    if (!isFileId(id)) return false;
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (!id.startsWith(hash)) return false;
    const path = this.pathOf(id);
    if (!existsSync(path)) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
    if (!this.store.getFileRecord(id)) {
      this.store.putFileRecord({
        id,
        name: name.slice(0, 255) || 'Untitled',
        mime: mime || 'application/octet-stream',
        size: bytes.byteLength,
        createdAt: Date.now(),
      });
    }
    return true;
  }

  /** Absolute path of a stored file, or `null` for an invalid or unknown id. */
  resolve(id: string): string | null {
    if (!isFileId(id)) return null;
    const path = this.pathOf(id);
    return existsSync(path) ? path : null;
  }

  private pathOf(id: string): string {
    return join(this.dir, id);
  }
}

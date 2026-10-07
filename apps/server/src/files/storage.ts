import type { Readable } from 'node:stream';

/** Where attachment bytes live. Keys are `<workspace id>/<file id>`. */
export interface FileStorage {
  has(key: string): Promise<boolean>;
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  /** Store a file from a local path (uploads are streamed to a temp file first). */
  putFile(key: string, path: string, size: number, mime: string): Promise<void>;
  /** The file's bytes as a stream, or null if it isn't stored. */
  get(key: string): Promise<{ body: Readable; size: number } | null>;
  delete(key: string): Promise<void>;
  /** Fails if the storage can't be reached (readiness checks). */
  check(): Promise<void>;
}

/** File ids: a sha256 and an optional extension (as made by the desktop's file store). */
export const FILE_ID = /^[0-9a-f]{64}(\.[a-z0-9]{1,10})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function fileKey(workspaceId: string, fileId: string): string {
  if (!UUID.test(workspaceId) || !FILE_ID.test(fileId)) throw new Error('Invalid file key');
  return `${workspaceId}/${fileId}`;
}

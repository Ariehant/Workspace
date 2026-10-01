import { pathToFileURL } from 'node:url';
import type { FileStore } from '@workspace/storage-local';
import {
  isFileId,
  parseLinkPreview,
  type LinkPreview,
  type SqliteStore,
} from '@workspace/storage-local';
import { ipcMain, net, protocol, shell } from 'electron';
import { IPC } from '../shared/ipc';

/** `ws-file://<id>` serves attachments to the sandboxed renderer. */
export const FILE_SCHEME = 'ws-file';

const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const PREVIEW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PREVIEW_TIMEOUT_MS = 6_000;
const PREVIEW_MAX_BYTES = 1024 * 1024;

/** Must run before `app.whenReady()`. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_SCHEME,
      // `stream` lets <video>/<audio> seek with range requests.
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Read at most `limit` bytes of a response body. */
async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

async function fetchPreview(url: string): Promise<LinkPreview> {
  const response = await net.fetch(url, {
    signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
    headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
  });
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !type.includes('html')) {
    await response.body?.cancel().catch(() => {});
    return parseLinkPreview('', response.url || url);
  }
  return parseLinkPreview(await readLimited(response, PREVIEW_MAX_BYTES), response.url || url);
}

/** Serve `ws-file://`, and handle attachment and link-preview IPC. Call after ready. */
export function registerFiles(files: FileStore, store: SqliteStore): void {
  protocol.handle(FILE_SCHEME, async (request) => {
    const id = new URL(request.url).hostname;
    const path = files.resolve(id);
    if (!path) return new Response('Not found', { status: 404 });
    // net.fetch on file:// handles Range requests and sets the content type.
    const response = await net.fetch(pathToFileURL(path).href, { headers: request.headers });
    // The UI page (file://) is a different origin; let it read attachments with fetch().
    const headers = new Headers(response.headers);
    headers.set('access-control-allow-origin', '*');
    return new Response(response.body, { status: response.status, headers });
  });

  ipcMain.handle(IPC.fileImport, (_event, bytes: unknown, name: unknown, mime: unknown) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IMPORT_BYTES) {
      throw new Error('File is missing or larger than 512 MB');
    }
    return files.import(bytes, String(name ?? ''), String(mime ?? ''));
  });

  ipcMain.handle(IPC.fileOpen, async (_event, id: unknown) => {
    const path = isFileId(id) ? files.resolve(id) : null;
    if (!path) return false;
    return (await shell.openPath(path)) === '';
  });

  ipcMain.handle(IPC.linkPreview, async (_event, raw: unknown) => {
    let url: URL;
    try {
      url = new URL(String(raw));
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const cached = store.getLinkPreview<LinkPreview>(url.href, PREVIEW_MAX_AGE_MS);
    if (cached) return cached;
    try {
      const preview = await fetchPreview(url.href);
      store.putLinkPreview(url.href, preview);
      return preview;
    } catch {
      // Offline or unreachable: show a plain card, and try again next time.
      return parseLinkPreview('', url.href);
    }
  });
}

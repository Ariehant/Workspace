/** A file from the archive (or picked directly), by its path inside it. */
export interface ArchiveFile {
  path: string;
  data: Uint8Array;
}

/** `Title <32 hex>.md`, `Title <32 hex>_all.csv`... (Notion's export names). */
const NOTION_NAME = /^(.*?) ?([0-9a-f]{32})(_all)?\.([a-z0-9]+)$/i;
const NOTION_DIR = /^(.*?) ?([0-9a-f]{32})$/i;

export interface ParsedName {
  title: string;
  /** Notion's id (32 hex), or null for names without one. */
  id: string | null;
  ext: string;
  /** `_all.csv`: every row of a database (rather than one view's). */
  all: boolean;
}

export function parseName(name: string): ParsedName {
  const m = NOTION_NAME.exec(name);
  if (m)
    return {
      title: m[1]!.trim(),
      id: m[2]!.toLowerCase(),
      ext: m[4]!.toLowerCase(),
      all: Boolean(m[3]),
    };
  const dot = name.lastIndexOf('.');
  return {
    title: dot > 0 ? name.slice(0, dot) : name,
    id: null,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
    all: false,
  };
}

/** The Notion id of a folder (`Title <id>`), if it has one. */
export function folderId(name: string): string | null {
  return NOTION_DIR.exec(name)?.[2]?.toLowerCase() ?? null;
}

export const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Resolve a relative link (URL-encoded, as in exports) against the file it's in. */
export function resolvePath(from: string, href: string): string | null {
  let target: string;
  try {
    target = decodeURIComponent(href.split('#')[0]!.split('?')[0]!);
  } catch {
    target = href;
  }
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const parts = target.startsWith('/') ? [] : dirname(from).split('/').filter(Boolean);
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

export const mimeOf = (path: string) =>
  MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

/** The block an attachment becomes. */
export function mediaType(path: string): 'image' | 'video' | 'audio' | 'pdf' | 'file' {
  const mime = mimeOf(path);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

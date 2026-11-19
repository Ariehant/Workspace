/**
 * Which files the page can show a preview of (Phase 8 N9): images, PDFs, Word documents and
 * Excel workbooks. Anything else opens in its own app.
 */
export type PreviewKind = 'image' | 'pdf' | 'docx' | 'xlsx';

const BY_EXTENSION: Record<string, PreviewKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
};

const BY_MIME: Record<string, PreviewKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** The preview a file has, by its name (then its type), or null. SVGs aren't previewed. */
export function previewKindOf(name: string, mime = ''): PreviewKind | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const byName = extension ? BY_EXTENSION[extension] : undefined;
  if (byName) return byName;
  if (BY_MIME[mime]) return BY_MIME[mime]!;
  return mime.startsWith('image/') && mime !== 'image/svg+xml' ? 'image' : null;
}

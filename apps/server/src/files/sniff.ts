/**
 * What an upload really is, from its first bytes (the type a client claims is only a
 * hint). The server serves files with the type it decided on, so a file can't pass as
 * an image to be shown inline while being something else.
 */

const ascii = (bytes: Uint8Array, from: number, length: number) =>
  String.fromCharCode(...bytes.subarray(from, from + length));

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((b, i) => bytes[offset + i] === b);

/** The type the content shows, or null when it isn't one we recognize. */
export function sniff(head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(head, 0, 4) === 'RIFF') {
    const kind = ascii(head, 8, 4);
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'WAVE') return 'audio/wav';
    if (kind === 'AVI ') return 'video/x-msvideo';
  }
  if (ascii(head, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(head, 4, 4) === 'ftyp') {
    const brand = ascii(head, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ') return 'audio/mp4';
    return 'video/mp4';
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(head, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(head, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) {
    return 'audio/mpeg';
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  // Markup a browser would run: recognized whatever it's called.
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(head.subarray(0, 512))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) {
    return 'image/svg+xml';
  }
  if (/^<(!doctype html|html|head|body|script)\b/.test(text)) return 'text/html';
  return null;
}

/** Types browsers show inline: only trusted when the content confirms them. */
const SHOWN = /^(image|video|audio)\/|^application\/pdf$/i;

/** The type to store an upload under, from what it claims and what it is. */
export function decideMime(declared: string, head: Uint8Array): string {
  const claimed = declared.split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
  const found = sniff(head);
  if (found) {
    // Office documents, EPUBs, JARs… are zips: keep their more precise name.
    if (found === 'application/zip' && !SHOWN.test(claimed)) return claimed;
    return found;
  }
  // Claims to be media, but isn't anything we recognize: just bytes.
  return SHOWN.test(claimed) ? 'application/octet-stream' : claimed;
}

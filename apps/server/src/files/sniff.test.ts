import { describe, expect, it } from 'vitest';
import { decideMime, sniff } from './sniff';

const b = (...values: (number | string)[]) =>
  new Uint8Array(
    values.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])),
  );

describe('sniff', () => {
  it('recognizes common formats from their first bytes', () => {
    expect(sniff(b(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniff(b(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniff(b('GIF89a'))).toBe('image/gif');
    expect(sniff(b('RIFF', 0, 0, 0, 0, 'WEBPVP8 '))).toBe('image/webp');
    expect(sniff(b('RIFF', 0, 0, 0, 0, 'WAVEfmt '))).toBe('audio/wav');
    expect(sniff(b('%PDF-1.7'))).toBe('application/pdf');
    expect(sniff(b(0, 0, 0, 0x20, 'ftypisom'))).toBe('video/mp4');
    expect(sniff(b(0, 0, 0, 0x20, 'ftypqt  '))).toBe('video/quicktime');
    expect(sniff(b(0, 0, 0, 0x20, 'ftypavif'))).toBe('image/avif');
    expect(sniff(b(0x1a, 0x45, 0xdf, 0xa3))).toBe('video/webm');
    expect(sniff(b('OggS'))).toBe('audio/ogg');
    expect(sniff(b('ID3', 4))).toBe('audio/mpeg');
    expect(sniff(b('PK', 3, 4))).toBe('application/zip');
    expect(sniff(b(0xef, 0xbb, 0xbf, '  <svg xmlns="http://www.w3.org/2000/svg">'))).toBe(
      'image/svg+xml',
    );
    expect(sniff(b('<?xml version="1.0"?>\n<svg>'))).toBe('image/svg+xml');
    expect(sniff(b('  <!DOCTYPE HTML><p>'))).toBe('text/html');
    expect(sniff(b('<script>alert(1)</script>'))).toBe('text/html');
    expect(sniff(b('plain text'))).toBeNull();
    expect(sniff(b())).toBeNull();
  });

  it('decides the stored type', () => {
    expect(decideMime('image/jpeg', b(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(decideMime('image/png', b('<html>'))).toBe('text/html');
    expect(decideMime('image/png', b('garbage'))).toBe('application/octet-stream');
    expect(decideMime('application/pdf', b('garbage'))).toBe('application/octet-stream');
    expect(decideMime('text/plain; charset=utf-8', b('hello'))).toBe('text/plain');
    expect(decideMime('', b('hello'))).toBe('application/octet-stream');
    // Zip-based formats keep their own name; a zip passed off as an image doesn't.
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(decideMime(docx, b('PK', 3, 4))).toBe(docx);
    expect(decideMime('image/png', b('PK', 3, 4))).toBe('application/zip');
  });
});

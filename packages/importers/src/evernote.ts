import { ImportBuilder } from './build';
import { htmlBlocks } from './html';
import type { ImportOptions, ImportReport, ImportTarget } from './import';
import type { LinkTarget } from './markdown';
import { md5Hex } from './md5';

/**
 * Evernote's export (`.enex`): each file a notebook, each note a row of a database named
 * after it, with the note's content (ENML, Evernote's XHTML), attachments, tags, created and
 * updated dates and source address.
 */

export interface EnexResource {
  hash: string;
  data: Uint8Array;
  mime: string;
  name: string | null;
}

export interface EnexNote {
  title: string;
  /** The note's ENML (`<en-note>…</en-note>`). */
  content: string;
  /** `YYYY-MM-DDTHH:mm`, local time. */
  created: string | null;
  updated: string | null;
  createdMs: number | null;
  tags: string[];
  sourceUrl: string | null;
  resources: EnexResource[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

/** The text of the first `<tag>` in `xml` (entities and CDATA decoded). */
function field(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]!).trim() : null;
}

const all = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map(
    (m) => m[1]!,
  );

/** `20231005T101500Z` (UTC) → local `YYYY-MM-DDTHH:mm`, and its time. */
function enexDate(text: string | null): { local: string; ms: number } | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text ?? '');
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    ms,
    local: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function base64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The notes of an `.enex` file. */
export function parseEnex(xml: string): EnexNote[] {
  return all(xml, 'note').map((note) => {
    const created = enexDate(field(note, 'created'));
    const updated = enexDate(field(note, 'updated'));
    const attributes = field(note, 'note-attributes') ?? '';
    const resources = all(note, 'resource').flatMap((resource): EnexResource[] => {
      const raw = /<data(?:\s[^>]*)?>([\s\S]*?)<\/data>/.exec(resource)?.[1];
      if (!raw) return [];
      const data = base64(raw);
      return [
        {
          hash: md5Hex(data),
          data,
          mime: field(resource, 'mime') ?? 'application/octet-stream',
          name: field(resource, 'file-name'),
        },
      ];
    });
    // The content is ENML inside CDATA; keep its markup (only the CDATA wrapper goes).
    const content = /<content>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/content>/.exec(note)?.[1] ?? '';
    return {
      title: field(note, 'title') ?? 'Untitled',
      content,
      created: created?.local ?? null,
      updated: updated?.local ?? null,
      createdMs: created?.ms ?? null,
      tags: all(note, 'tag')
        .map((t) => decodeXml(t).trim())
        .filter(Boolean),
      sourceUrl: field(attributes, 'source-url'),
      resources,
    };
  });
}

const RESOURCE = 'evernote-resource:';

/**
 * ENML as HTML the converter reads: `<en-note>` as the body; attachments (`<en-media>`) as
 * images or links to `evernote-resource:<hash>`; both kinds of checklists (`<en-todo>` and
 * Evernote 10's `--en-todo` lists) as to-do lists. Encrypted text can't be read.
 */
export function enmlToHtml(enml: string, warn: (message: string) => void): string {
  let html = enml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<en-note([^>]*)>/i, '<body><div$1>')
    .replace(/<\/en-note>/i, '</div></body>');
  if (/<en-crypt/i.test(html)) {
    warn('Encrypted text in Evernote notes can’t be imported');
    html = html.replace(/<en-crypt[\s\S]*?<\/en-crypt>/gi, '');
  }
  // Every attachment as an <img>: the converter makes it the block its kind needs (an image,
  // a PDF, audio, video or a file).
  html = html.replace(/<en-media\b([^>]*?)\/?>(?:<\/en-media>)?/gi, (_, attrs: string) => {
    const hash = /hash="([0-9a-f]+)"/i.exec(attrs)?.[1] ?? '';
    return `<img src="${RESOURCE}${hash}">`;
  });
  // Evernote 10: <ul style="--en-todo:true;"><li style="--en-checked:true;">…
  html = html.replace(/<ul\b([^>]*--en-todo:\s*true[^>]*)>/gi, '<ul class="to-do-list"$1>');
  html = html.replace(/<li\b([^>]*)>/gi, (whole, attrs: string) =>
    /--en-checked:\s*true/i.test(attrs)
      ? `<li${attrs}><input type="checkbox" checked>`
      : /--en-checked:\s*false/i.test(attrs)
        ? `<li${attrs}><input type="checkbox">`
        : whole,
  );
  // Older notes: a block that starts with <en-todo checked="true"/> is a to-do.
  html = html.replace(
    /<(div|p)\b([^>]*)>\s*<en-todo\b([^>]*?)\/?>(?:<\/en-todo>)?([\s\S]*?)<\/\1>/gi,
    (_, _tag: string, _attrs: string, todo: string, rest: string) =>
      `<ul class="to-do-list"><li><input type="checkbox"${/checked="true"/i.test(todo) ? ' checked' : ''}>${rest}</li></ul>`,
  );
  // A to-do anywhere else: a box character.
  html = html.replace(/<en-todo\b([^>]*?)\/?>(?:<\/en-todo>)?/gi, (_, todo: string) =>
    /checked="true"/i.test(todo) ? '☑ ' : '☐ ',
  );
  return html;
}

/** A notebook's name from its file: `Recipes.enex` → `Recipes`. */
const notebookName = (file: string) =>
  file
    .replace(/^.*\//, '')
    .replace(/\.enex$/i, '')
    .trim() || 'Notebook';

export function importEvernote(
  files: readonly { path: string; text: string }[],
  target: ImportTarget,
  options: ImportOptions,
): ImportReport {
  const build = new ImportBuilder(target, options);
  const notebooks = files.map((file) => ({
    name: notebookName(file.path),
    notes: parseEnex(file.text),
  }));
  const total = notebooks.reduce((n, b) => n + b.notes.length, 0);
  let done = 0;
  for (const notebook of notebooks) {
    const tags = [...new Set(notebook.notes.flatMap((n) => n.tags))].sort((a, b) =>
      a.localeCompare(b),
    );
    const db = build.database(notebook.name, [
      { name: 'Title', type: 'title' },
      { name: 'Tags', type: 'multiSelect', options: tags.map((name) => ({ name })) },
      { name: 'Created', type: 'date' },
      { name: 'Updated', type: 'date' },
      { name: 'Source', type: 'url' },
    ]);
    for (const note of notebook.notes) {
      const rowId = db.row({
        title: note.title,
        values: {
          Tags: note.tags,
          Created: note.created,
          Updated: note.updated,
          Source: note.sourceUrl,
        },
        ...(note.createdMs !== null ? { at: note.createdMs } : {}),
      });
      const stored = new Map<string, LinkTarget>();
      const link = (href: string): LinkTarget | null => {
        if (!href.startsWith(RESOURCE)) return null;
        const hash = href.slice(RESOURCE.length);
        let found = stored.get(hash);
        if (!found) {
          const resource = note.resources.find((r) => r.hash === hash);
          if (!resource) return { kind: 'missing' };
          const extension = resource.mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
          found = build.file(
            resource.data,
            resource.name ?? `attachment.${extension}`,
            resource.mime,
          );
          stored.set(hash, found);
        }
        return found;
      };
      build.content(
        rowId,
        htmlBlocks(
          enmlToHtml(note.content, (m) => build.warn(m)),
          {
            link,
            warn: (m) => build.warn(m),
          },
        ),
      );
      // Attachments the note doesn't show inline are added at its end.
      for (const resource of note.resources) {
        if (stored.has(resource.hash)) continue;
        const file = link(`${RESOURCE}${resource.hash}`);
        if (file?.kind === 'file') {
          build.content(rowId, [
            { type: file.media, attrs: { fileId: file.fileId, name: file.name } },
          ]);
        }
      }
      options.onProgress?.(++done, total);
    }
  }
  return build.done();
}

/**
 * Notion's objects (users, pages, databases, data sources, lists) from ours. The
 * `Notion-Version` picks the shape: from 2025-09-03 a database has one data source
 * (with the database's own id here), and holds no properties itself.
 */
import { FILE_ICON_PREFIX, type PageCover } from '@workspace/core';
import { invalid } from './errors';
import { compactId, parseId } from './ids';
import { richText } from './rich-text';

export type ApiVersion = '2022-06-28' | '2025-09-03';

/** The shape a `Notion-Version` asks for; null if it isn't a version. */
export function parseVersion(raw: unknown): ApiVersion | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw >= '2025-09-03' ? '2025-09-03' : '2022-06-28';
}

export interface FileLinks {
  /** A stored file's URL, and when it stops working. */
  fileUrl(id: string, name: string): { url: string; expiry_time: string };
  /** A page's address in the app. */
  pageUrl(id: string): string;
}

// --- Users ---------------------------------------------------------------------------

export function personObject(
  user: { id: string; name: string; avatar: string | null; email?: string | null },
  withEmail: boolean,
) {
  return {
    object: 'user',
    id: user.id,
    type: 'person',
    name: user.name,
    avatar_url: user.avatar?.startsWith('http') ? user.avatar : null,
    person: withEmail && user.email ? { email: user.email } : {},
  };
}

export function botObject(
  bot: { id: string; name: string; icon: string | null },
  workspaceName: string,
) {
  return {
    object: 'user',
    id: bot.id,
    type: 'bot',
    name: bot.name,
    avatar_url: null,
    bot: { owner: { type: 'workspace', workspace: true }, workspace_name: workspaceName },
  };
}

// --- Icons and covers -----------------------------------------------------------------

export function iconObject(icon: string | null, links: FileLinks) {
  if (!icon) return null;
  if (icon.startsWith(FILE_ICON_PREFIX)) {
    const id = icon.slice(FILE_ICON_PREFIX.length);
    return { type: 'file', file: links.fileUrl(id, 'icon') };
  }
  if (/^https?:\/\//.test(icon)) return { type: 'external', external: { url: icon } };
  return { type: 'emoji', emoji: icon };
}

export function coverObject(cover: PageCover | null, links: FileLinks) {
  if (!cover) return null;
  if (cover.kind === 'file') return { type: 'file', file: links.fileUrl(cover.value, 'cover') };
  if (/^https?:\/\//.test(cover.value)) return { type: 'external', external: { url: cover.value } };
  // Colors and gradients have no Notion equivalent.
  return null;
}

/** An icon sent in: an emoji (null removes it). Images can't be set through the API yet. */
export function parseIcon(raw: unknown, where = 'body.icon'): string | null {
  if (raw === null) return null;
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (o && (o.type === 'emoji' || 'emoji' in o)) {
    if (typeof o.emoji !== 'string' || !o.emoji || o.emoji.length > 16) {
      throw invalid(`${where}.emoji should be an emoji.`);
    }
    return o.emoji;
  }
  throw invalid(`${where} should be an emoji, or null (images can't be set through the API).`);
}

/** A cover sent in: only null (removing it); images can't be set through the API yet. */
export function parseCover(raw: unknown, where = 'body.cover'): null {
  if (raw === null) return null;
  throw invalid(`${where} can only be removed (null) through the API.`);
}

// --- Parents -------------------------------------------------------------------------

export type Parent =
  { kind: 'workspace' } | { kind: 'page'; id: string } | { kind: 'database'; id: string };

export function parentObject(parent: Parent, version: ApiVersion) {
  switch (parent.kind) {
    case 'workspace':
      return { type: 'workspace', workspace: true };
    case 'page':
      return { type: 'page_id', page_id: parent.id };
    case 'database':
      return version === '2025-09-03'
        ? { type: 'data_source_id', data_source_id: parent.id, database_id: parent.id }
        : { type: 'database_id', database_id: parent.id };
  }
}

/** A parent sent in: a page, a database, or (from 2025-09-03) a data source. */
export function parseParent(raw: unknown): Parent {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) throw invalid('body.parent should be an object.');
  for (const key of ['database_id', 'data_source_id'] as const) {
    if (o[key] !== undefined) {
      const id = parseId(o[key]);
      if (!id) throw invalid(`body.parent.${key} should be a valid uuid.`);
      return { kind: 'database', id };
    }
  }
  if (o.page_id !== undefined) {
    const id = parseId(o.page_id);
    if (!id) throw invalid('body.parent.page_id should be a valid uuid.');
    return { kind: 'page', id };
  }
  if (o.workspace === true) {
    throw invalid('body.parent: integrations can only add pages under pages shared with them.');
  }
  throw invalid('body.parent should have a page_id, database_id or data_source_id.');
}

// --- Pages and databases -------------------------------------------------------------

export interface Common {
  id: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  updatedBy: string | null;
  icon: string | null;
  cover: PageCover | null;
  trashed: boolean;
  parent: Parent;
}

const userRef = (id: string | null) => ({ object: 'user', id });
const iso = (ms: number) => new Date(ms).toISOString();

function common(o: Common, version: ApiVersion, links: FileLinks) {
  return {
    id: o.id,
    created_time: iso(o.createdAt),
    last_edited_time: iso(o.updatedAt),
    created_by: userRef(o.createdBy),
    last_edited_by: userRef(o.updatedBy),
    cover: coverObject(o.cover, links),
    icon: iconObject(o.icon, links),
    parent: parentObject(o.parent, version),
    archived: o.trashed,
    in_trash: o.trashed,
  };
}

export function pageObject(
  o: Common,
  properties: Record<string, unknown>,
  version: ApiVersion,
  links: FileLinks,
) {
  return {
    object: 'page',
    ...common(o, version, links),
    properties,
    url: links.pageUrl(o.id),
    public_url: null,
  };
}

export function databaseObject(
  o: Common & { title: string; description: string; isInline: boolean },
  schema: Record<string, unknown>,
  version: ApiVersion,
  links: FileLinks,
) {
  const base = {
    object: 'database',
    ...common(o, version, links),
    title: richText(o.title),
    description: richText(o.description),
    is_inline: o.isInline,
    url: links.pageUrl(o.id),
    public_url: null,
  };
  if (version === '2025-09-03') {
    return { ...base, data_sources: [{ id: o.id, name: o.title }] };
  }
  return { ...base, properties: schema };
}

export function dataSourceObject(
  o: Common & { title: string; description: string },
  schema: Record<string, unknown>,
  links: FileLinks,
) {
  return {
    object: 'data_source',
    ...common(o, '2025-09-03', links),
    parent: { type: 'database_id', database_id: o.id },
    database_parent: parentObject(o.parent, '2025-09-03'),
    title: richText(o.title),
    description: richText(o.description),
    properties: schema,
    url: links.pageUrl(o.id),
    public_url: null,
  };
}

/** The app's address for a page (as Notion's: the title, then the compact id). */
export function pageUrlFor(base: string, title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${base}/${slug ? `${slug}-` : ''}${compactId(id)}`;
}

// --- Lists ---------------------------------------------------------------------------

export interface Paging {
  startCursor: string | null;
  pageSize: number;
}

/** `start_cursor` and `page_size` (≤ 100, default 100), from a body or a query string. */
export function parsePaging(input: Record<string, unknown> | undefined): Paging {
  const size = input?.page_size;
  let pageSize = 100;
  if (size !== undefined) {
    const n = typeof size === 'string' ? Number(size) : size;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100) {
      throw invalid('page_size should be an integer from 1 to 100.');
    }
    pageSize = n;
  }
  const cursor = input?.start_cursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    throw invalid('start_cursor should be a string.');
  }
  return { startCursor: (cursor as string | undefined) ?? null, pageSize };
}

/**
 * One page of `items` (cursors are the id of the first item on a page, as Notion's
 * are), as a list object of `type`.
 */
export function listObject<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  paging: Paging,
  type: string,
  render: (item: T) => unknown,
  extra: Record<string, unknown> = {},
) {
  let start = 0;
  if (paging.startCursor) {
    const id = parseId(paging.startCursor) ?? paging.startCursor;
    start = items.findIndex((item) => idOf(item) === id);
    if (start < 0) throw invalid('start_cursor is not a valid cursor for this list.');
  }
  const slice = items.slice(start, start + paging.pageSize);
  const next = items[start + paging.pageSize];
  return {
    object: 'list',
    results: slice.map(render),
    next_cursor: next === undefined ? null : idOf(next),
    has_more: next !== undefined,
    type,
    [type]: {},
    ...extra,
  };
}

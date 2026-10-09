/**
 * `POST /v1/search`: pages, databases (data sources from 2025-09-03) and rows shared with
 * the integration, whose title contains the query. Read from the trees and databases it
 * can see (not the search index, which lags behind writes a moment), newest edit first
 * unless asked otherwise.
 */
import { invalid, listObject, parsePaging } from '@workspace/api-model';
import { isInTrash, listPages } from '@workspace/core';
import { isDatabaseDoc, readDatabase } from '@workspace/database';
import type { FastifyInstance } from 'fastify';
import { viewOf } from './plugin';
import type { ApiView, Located } from './view';

interface Hit {
  id: string;
  title: string;
  updatedAt: number;
  kind: 'page' | 'database' | 'row';
}

/** Everything the integration can see (live pages and rows, not in the trash). */
async function everything(api: ApiView): Promise<Hit[]> {
  const hits = new Map<string, Hit>();
  for (const scope of api.readableScopes()) {
    const tree = await api.doc(scope.treeDoc);
    if (!tree) continue;
    for (const page of listPages(tree)) {
      if (hits.has(page.id) || isInTrash(tree, page.id)) continue;
      hits.set(page.id, {
        id: page.id,
        title: page.title,
        updatedAt: page.updatedAt,
        kind: page.kind === 'database' ? 'database' : 'page',
      });
      if (page.kind !== 'database') continue;
      const db = await api.doc(page.id);
      if (!db || !isDatabaseDoc(db)) continue;
      for (const row of readDatabase(db).rows) {
        if (row.isTemplate || row.trashedAt !== null || hits.has(row.id)) continue;
        hits.set(row.id, { id: row.id, title: row.title, updatedAt: row.updatedAt, kind: 'row' });
      }
    }
  }
  return [...hits.values()];
}

export function searchRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>('/search', async (request) => {
    const api = viewOf(request);
    api.need('readContent');
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) throw invalid('body should be an object.');
    const q = body.query === undefined ? '' : body.query;
    if (typeof q !== 'string') throw invalid('body.query should be a string.');

    let want: 'page' | 'database' | null = null;
    if (body.filter !== undefined) {
      const f = body.filter as { property?: unknown; value?: unknown };
      const databases = api.version === '2025-09-03' ? 'data_source' : 'database';
      if (f?.property !== 'object' || (f.value !== 'page' && f.value !== databases)) {
        throw invalid(
          `body.filter should be {"property": "object", "value": "page" | "${databases}"}.`,
        );
      }
      want = f.value === 'page' ? 'page' : 'database';
    }
    let direction: 'ascending' | 'descending' = 'descending';
    if (body.sort !== undefined) {
      const s = body.sort as { timestamp?: unknown; direction?: unknown };
      if (
        s?.timestamp !== 'last_edited_time' ||
        (s.direction !== 'ascending' && s.direction !== 'descending')
      ) {
        throw invalid('body.sort should be {"timestamp": "last_edited_time", "direction": …}.');
      }
      direction = s.direction;
    }

    const needle = q.trim().toLowerCase();
    const hits = (await everything(api))
      .filter((h) => !needle || h.title.toLowerCase().includes(needle))
      .filter((h) => !want || (want === 'database' ? h.kind === 'database' : h.kind !== 'database'))
      .sort((a, b) =>
        direction === 'descending' ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt,
      );
    const paging = parsePaging(body);
    // Only the page shown is turned into objects.
    const list = listObject(
      hits,
      (h) => h.id,
      paging,
      'page_or_database',
      (h) => h,
    );
    const results = [];
    for (const hit of list.results as Hit[]) {
      const found: Located | null = await api.find(hit.id);
      if (!found) continue;
      if (found.kind === 'database') {
        results.push(
          api.version === '2025-09-03'
            ? await api.dataSourceJson(found)
            : await api.databaseJson(found),
        );
      } else results.push(await api.pageJson(found));
    }
    return { ...list, results };
  });
}

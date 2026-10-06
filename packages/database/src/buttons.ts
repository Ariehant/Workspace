import type { ButtonStep } from '@workspace/core';
import { addRow, readDatabase, setCell } from './doc';
import { matchesFilter } from './filter';
import { resolvePlaceholders } from './placeholders';
import { relationIds } from './properties';
import { setRelation, type DocResolver } from './relations';
import { isLiveRow } from './templates';
import type { DisplayContext, Filter, Property } from './schema';

export interface StepContext {
  resolve: DocResolver;
  actor: string;
  now?: number;
  ctx: DisplayContext;
  /** The row a database button property was clicked in. */
  row?: { databaseId: string; rowId: string };
}

/** Write property values on a row; relations go through `setRelation` (two-way). */
function writeValues(
  context: StepContext,
  databaseId: string,
  rowId: string,
  properties: readonly Property[],
  values: Readonly<Record<string, unknown>>,
): void {
  const doc = context.resolve(databaseId);
  if (!doc) return;
  const resolved = resolvePlaceholders(values, properties, { me: context.actor, now: context.now });
  const byId = new Map(properties.map((p) => [p.id, p]));
  doc.transact(() => {
    for (const [id, value] of Object.entries(resolved)) {
      const property = byId.get(id);
      if (!property) continue;
      if (property.type === 'relation') {
        setRelation(context.resolve, databaseId, rowId, id, relationIds(value), context.actor);
      } else {
        setCell(doc, rowId, id, value, context.actor, context.now);
      }
    }
  });
}

/**
 * Run a database step of a button: add a page, edit matching pages, or edit the
 * row the button is in. Returns the id of an added page (to open), if any.
 * Missing databases are skipped.
 */
export function runDatabaseStep(step: ButtonStep, context: StepContext): string | null {
  switch (step.kind) {
    case 'addPage': {
      const doc = context.resolve(step.databaseId);
      if (!doc) return null;
      const { properties } = readDatabase(doc);
      let id = '';
      doc.transact(() => {
        id = addRow(doc, { actor: context.actor, title: step.title, now: context.now });
        writeValues(context, step.databaseId, id, properties, step.values);
      });
      return id;
    }
    case 'editPages': {
      const doc = context.resolve(step.databaseId);
      if (!doc) return null;
      const snapshot = readDatabase(doc);
      const byId = new Map(snapshot.properties.map((p) => [p.id, p]));
      const filter = (step.filter as Filter | null) ?? null;
      const rows = snapshot.rows.filter(
        (r) => isLiveRow(r) && matchesFilter(r, filter, byId, context.ctx),
      );
      doc.transact(() => {
        for (const row of rows) {
          writeValues(context, step.databaseId, row.id, snapshot.properties, step.values);
        }
      });
      return null;
    }
    case 'editThisRow': {
      if (!context.row) return null;
      const doc = context.resolve(context.row.databaseId);
      if (!doc) return null;
      const { properties } = readDatabase(doc);
      writeValues(context, context.row.databaseId, context.row.rowId, properties, step.values);
      return null;
    }
    default:
      return null;
  }
}

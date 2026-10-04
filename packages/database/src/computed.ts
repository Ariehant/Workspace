import { FormulaCache } from './formula';
import { relationIds } from './properties';
import { computeRollup, rollupConfig } from './rollup';
import type { DatabaseSnapshot, DisplayContext, Property, RelatedPage, Row } from './schema';

/**
 * Snapshots of other databases: stored values only, or `computed` (with their own
 * relations, rollups and formulas; only asked for when a rollup reads one of those).
 * Resolvers break cycles by answering with the stored snapshot.
 */
export type SnapshotResolver = (
  databaseId: string,
  computed: boolean,
) => DatabaseSnapshot | undefined;

const COMPUTED_TYPES = new Set(['formula', 'rollup', 'relation']);

interface Target {
  snapshot: DatabaseSnapshot;
  /** Live (not trashed) rows by id. */
  rows: Map<string, Row>;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

interface Entry {
  out: Row;
  generation: number;
  /** The related rows the values were computed from. */
  read: { databaseId: string; id: string; row: Row | undefined }[];
}

const samePages = (a: ReadonlyMap<string, RelatedPage>, b: ReadonlyMap<string, RelatedPage>) => {
  if (a.size !== b.size) return false;
  for (const [id, page] of a) {
    const other = b.get(id);
    if (
      !other ||
      other.title !== page.title ||
      other.icon !== page.icon ||
      other.databaseId !== page.databaseId
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Turns a database snapshot into what views show: relation values as arrays of
 * live page ids, rollup values, formula values, and the related pages' titles.
 * A row is recomputed only when it, the rows it links to, or the related pages'
 * titles change, so formulas over unchanged rows are not re-evaluated.
 */
export class ComputedCache {
  private readonly formulas = new FormulaCache();
  private readonly selfFormulas = new FormulaCache();
  private entries = new WeakMap<Row, Entry>();
  private generation = 0;
  private deps: unknown[] = [];
  private properties: Property[] = [];
  private related: ReadonlyMap<string, RelatedPage> = new Map();
  private targets = new Map<string, Target>();

  apply(
    snapshot: DatabaseSnapshot,
    ctx: DisplayContext,
    resolve: SnapshotResolver,
    selfId: string,
  ): DatabaseSnapshot {
    const relations = snapshot.properties.filter((p) => p.type === 'relation');
    const rollups = snapshot.properties.filter((p) => p.type === 'rollup');
    if (relations.length === 0 && rollups.length === 0) return this.formulas.apply(snapshot, ctx);

    // The databases this one links to (itself, with formula values, for self-relations).
    this.targets = new Map();
    const related = new Map<string, RelatedPage>();
    for (const relation of relations) {
      const databaseId = relation.config.databaseId ?? '';
      if (this.targets.has(databaseId)) continue;
      // Rollups through this relation that read computed values need the computed side.
      const raw = databaseId === selfId ? snapshot : resolve(databaseId, false);
      if (!raw) continue;
      const needsComputed = rollups.some((r) => {
        const via = relations.find((p) => p.id === r.config.relationId);
        if (via?.config.databaseId !== databaseId) return false;
        const read = raw.properties.find((p) => p.id === r.config.targetPropertyId);
        return read !== undefined && COMPUTED_TYPES.has(read.type);
      });
      const target = !needsComputed
        ? raw
        : databaseId === selfId
          ? this.selfFormulas.apply(snapshot, ctx)
          : (resolve(databaseId, true) ?? raw);
      const rows = new Map<string, Row>();
      for (const row of target.rows) {
        if (row.trashedAt !== null) continue;
        rows.set(row.id, row);
        related.set(row.id, { id: row.id, title: row.title, icon: row.icon, databaseId });
      }
      this.targets.set(databaseId, { snapshot: target, rows });
    }

    const users = [...ctx.users].map(([id, name]) => `${id}=${name}`).join(',');
    const deps: unknown[] = [snapshot.properties, users, ctx.me];
    for (const [id, target] of this.targets) deps.push(id, target.snapshot.properties);
    const pagesChanged = !samePages(related, this.related);
    if (pagesChanged) this.related = related;
    if (pagesChanged || !sameList(deps, this.deps)) {
      this.generation++;
      this.entries = new WeakMap();
    }
    if (!sameList(deps, this.deps)) {
      this.deps = deps;
      this.properties = snapshot.properties.map((p) => {
        if (p.type !== 'rollup') return p;
        return { ...p, config: rollupConfig(p, this.rollupTarget(p, snapshot.properties)) };
      });
    }

    const rows = snapshot.rows.map((row) => {
      const entry = this.entries.get(row);
      if (
        entry &&
        entry.generation === this.generation &&
        entry.read.every((r) => this.targets.get(r.databaseId)?.rows.get(r.id) === r.row)
      ) {
        return entry.out;
      }
      const fresh = this.computeRow(row, relations, rollups, snapshot.properties, ctx);
      this.entries.set(row, fresh);
      return fresh.out;
    });
    const out = this.formulas.apply(
      { ...snapshot, properties: this.properties, rows, related: this.related },
      { ...ctx, pages: this.related },
    );
    // Nothing changed (another database did): keep the same snapshot for memos.
    const last = this.last;
    if (
      last &&
      last.properties === out.properties &&
      last.views === out.views &&
      last.meta === out.meta &&
      last.related === out.related &&
      sameList(last.rows, out.rows)
    ) {
      return last;
    }
    this.last = out;
    return out;
  }

  private last: DatabaseSnapshot | null = null;

  private relationTarget(relation: Property | undefined): Target | undefined {
    return relation ? this.targets.get(relation.config.databaseId ?? '') : undefined;
  }

  private rollupTarget(rollup: Property, properties: readonly Property[]): Property | undefined {
    const relation = properties.find((p) => p.id === rollup.config.relationId);
    return this.relationTarget(relation)?.snapshot.properties.find(
      (p) => p.id === rollup.config.targetPropertyId,
    );
  }

  private computeRow(
    row: Row,
    relations: readonly Property[],
    rollups: readonly Property[],
    properties: readonly Property[],
    ctx: DisplayContext,
  ): Entry {
    const values = { ...row.values };
    const read: Entry['read'] = [];
    const linked = new Map<string, string[]>();
    for (const relation of relations) {
      const target = this.relationTarget(relation);
      const all = relationIds(row.values[relation.id]);
      const databaseId = relation.config.databaseId ?? '';
      for (const id of all) read.push({ databaseId, id, row: target?.rows.get(id) });
      const ids = all.filter((id) => target?.rows.has(id));
      linked.set(relation.id, ids);
      if (ids.length) values[relation.id] = ids;
      else delete values[relation.id];
    }
    for (const rollup of rollups) {
      const relation = properties.find((p) => p.id === rollup.config.relationId);
      const target = this.relationTarget(relation);
      const property = target?.snapshot.properties.find(
        (p) => p.id === rollup.config.targetPropertyId,
      );
      if (!relation || !target || !property) {
        values[rollup.id] = null;
        continue;
      }
      const rows = (linked.get(relation.id) ?? []).map((id) => target.rows.get(id)!);
      const targetCtx = { ...ctx, pages: target.snapshot.related ?? this.related };
      values[rollup.id] = computeRollup(
        rows,
        property,
        rollup.config.calculation ?? 'showOriginal',
        targetCtx,
      );
    }
    return { out: { ...row, values }, generation: this.generation, read };
  }
}

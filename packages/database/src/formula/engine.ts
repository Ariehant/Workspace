import { dateFromString } from '../format';
import { cellValue, isDateValue, optionsOf } from '../properties';
import type {
  DatabaseSnapshot,
  DateValue,
  DisplayContext,
  FormulaResultType,
  Property,
  Row,
} from '../schema';
import { check, evaluate } from './compile';
import { parse, propRefs, type Node } from './parser';
import { FormulaError, T, isDate, type FType, type FValue } from './types';
import { dateValue, formatValue } from './values';

/** The type a property has inside formulas. */
export function propertyFType(property: Property): FType {
  switch (property.type) {
    case 'number':
    case 'uniqueId':
      return T.number;
    case 'checkbox':
      return T.boolean;
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return T.date;
    case 'multiSelect':
    case 'files':
      return T.list(T.text);
    case 'person':
      return T.list(T.person);
    case 'createdBy':
    case 'lastEditedBy':
      return T.person;
    default:
      return T.text;
  }
}

/** A row's value of a (non-formula) property, as formulas see it. */
export function propertyFValue(row: Row, property: Property, ctx: DisplayContext): FValue {
  const value = cellValue(row, property);
  const person = (id: string) => ({
    kind: 'person' as const,
    id,
    name: ctx.users.get(id) ?? '',
    email: '',
  });
  switch (property.type) {
    case 'number':
    case 'uniqueId':
      return typeof value === 'number' ? value : null;
    case 'checkbox':
      return value === true;
    case 'select':
    case 'status':
      return optionsOf(property).find((o) => o.id === value)?.name ?? null;
    case 'multiSelect':
      return ((value as string[] | null) ?? [])
        .map((id) => optionsOf(property).find((o) => o.id === id)?.name)
        .filter((n): n is string => n !== undefined);
    case 'files':
      return ((value as { name: string }[] | null) ?? []).map((f) => f.name);
    case 'date': {
      if (!isDateValue(value)) return null;
      const time = value.start.includes('T');
      return dateValue(
        dateFromString(value.start).getTime(),
        time,
        value.end ? dateFromString(value.end).getTime() : null,
      );
    }
    case 'createdTime':
    case 'lastEditedTime':
      return typeof value === 'number' ? dateValue(value, true) : null;
    case 'person':
      return ((value as string[] | null) ?? []).map(person);
    case 'createdBy':
    case 'lastEditedBy':
      return typeof value === 'string' ? person(value) : null;
    default:
      return typeof value === 'string' ? value : null;
  }
}

export function resultTypeOf(t: FType): FormulaResultType {
  switch (t.kind) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    default:
      return 'text';
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (ms: number, time: boolean) => {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return time ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
};

/** A formula result as a cell value of its result type (so filters and sorts apply). */
export function toCellValue(value: FValue, type: FormulaResultType): unknown {
  if (value === null) return null;
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    case 'boolean':
      return value === true;
    case 'date':
      return isDate(value)
        ? ({
            start: isoOf(value.start, value.time),
            ...(value.end !== null ? { end: isoOf(value.end, value.time) } : {}),
          } satisfies DateValue)
        : null;
    default: {
      const text = formatValue(value);
      return text === '' ? null : text;
    }
  }
}

// --- Compiling a database's formulas -------------------------------------------------------

export interface CompiledFormula {
  property: Property;
  node: Node | null;
  type: FType;
  error: string | null;
  /** Ids of formula properties this one reads. */
  dependsOn: string[];
}

export interface CompiledFormulas {
  /** Formula properties in evaluation order (dependencies first). */
  order: CompiledFormula[];
  byId: ReadonlyMap<string, CompiledFormula>;
  /** Some formula reads the clock (`now()`, `today()`), so values age. */
  usesNow: boolean;
}

/** Parse, order and type-check every formula property of a database. */
export function compileFormulas(properties: readonly Property[]): CompiledFormulas {
  const byName = new Map<string, Property>();
  for (const p of properties) if (!byName.has(p.name)) byName.set(p.name, p);
  const formulas = properties.filter((p) => p.type === 'formula');
  const compiled = new Map<string, CompiledFormula>();
  let usesNow = false;

  for (const property of formulas) {
    const source = property.config.expression ?? '';
    const entry: CompiledFormula = {
      property,
      node: null,
      type: T.empty,
      error: null,
      dependsOn: [],
    };
    if (source.trim()) {
      try {
        entry.node = parse(source);
        entry.dependsOn = propRefs(entry.node)
          .map((r) => byName.get(r.name))
          .filter((p): p is Property => p?.type === 'formula')
          .map((p) => p.id);
        if (/\b(now|today)\s*\(/.test(source)) usesNow = true;
      } catch (error) {
        entry.error = error instanceof FormulaError ? error.message : String(error);
      }
    }
    compiled.set(property.id, entry);
  }

  // Order by dependencies; formulas in a cycle get an error.
  const order: CompiledFormula[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]): void => {
    const entry = compiled.get(id)!;
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const cycle = path.slice(path.indexOf(id)).map((p) => compiled.get(p)!.property.name);
      for (const p of path.slice(path.indexOf(id))) {
        compiled.get(p)!.error ??= `Circular reference: ${[...cycle, cycle[0]].join(' → ')}`;
      }
      return;
    }
    state.set(id, 'visiting');
    for (const dep of entry.dependsOn) visit(dep, [...path, id]);
    state.set(id, 'done');
    order.push(entry);
  };
  for (const property of formulas) visit(property.id, []);

  for (const entry of order) {
    if (!entry.node || entry.error) continue;
    try {
      entry.type = check(entry.node, {
        prop: (name) => {
          const p = byName.get(name);
          if (!p) return undefined;
          if (p.type !== 'formula') return propertyFType(p);
          const other = compiled.get(p.id)!;
          return other.error ? T.any : other.type;
        },
      });
    } catch (error) {
      entry.error = error instanceof FormulaError ? error.message : String(error);
    }
  }
  return { order, byId: compiled, usesNow };
}

/** Evaluate a row's formulas (in order). Rows with errors get null. */
export function evaluateRow(
  row: Row,
  compiled: CompiledFormulas,
  properties: readonly Property[],
  ctx: DisplayContext,
): Map<string, FValue> {
  const byName = new Map<string, Property>();
  for (const p of properties) if (!byName.has(p.name)) byName.set(p.name, p);
  const results = new Map<string, FValue>();
  const env = {
    prop: (name: string): FValue => {
      const p = byName.get(name);
      if (!p) return null;
      return p.type === 'formula' ? (results.get(p.id) ?? null) : propertyFValue(row, p, ctx);
    },
    page: { id: row.id, title: row.title },
    now: ctx.now ?? Date.now(),
  };
  for (const entry of compiled.order) {
    if (!entry.node || entry.error) {
      results.set(entry.property.id, null);
      continue;
    }
    try {
      results.set(entry.property.id, evaluate(entry.node, env));
    } catch {
      results.set(entry.property.id, null);
    }
  }
  return results;
}

/**
 * Computes formula values for snapshots, reusing results for rows that didn't change
 * (the handle keeps unchanged `Row` objects). Make a new cache when the properties,
 * users or (for formulas that read the clock) the minute change.
 */
export class FormulaCache {
  private rows = new WeakMap<Row, Row>();
  private compiled: CompiledFormulas | null = null;
  private properties: readonly Property[] | null = null;
  private key = '';

  /** The snapshot with formula values in `row.values` and result types in configs. */
  apply(snapshot: DatabaseSnapshot, ctx: DisplayContext): DatabaseSnapshot {
    if (!snapshot.properties.some((p) => p.type === 'formula')) return snapshot;
    if (this.properties !== snapshot.properties) {
      this.properties = snapshot.properties;
      this.compiled = compileFormulas(snapshot.properties);
      this.key = '';
    }
    const compiled = this.compiled!;
    const minute = compiled.usesNow ? Math.floor((ctx.now ?? Date.now()) / 60_000) : 0;
    const users = [...ctx.users].map(([id, name]) => `${id}=${name}`).join(',');
    const key = `${minute}|${users}|${ctx.me ?? ''}`;
    if (key !== this.key) {
      this.key = key;
      this.rows = new WeakMap();
    }

    const properties = snapshot.properties.map((p) => {
      const entry = compiled.byId.get(p.id);
      if (!entry) return p;
      return {
        ...p,
        config: {
          ...p.config,
          resultType: resultTypeOf(entry.type),
          formulaError: entry.error ?? undefined,
        },
      };
    });
    const types = new Map(
      properties.flatMap((p) => (p.config.resultType ? [[p.id, p.config.resultType]] : [])),
    );
    const rows = snapshot.rows.map((row) => {
      let out = this.rows.get(row);
      if (!out) {
        const values = { ...row.values };
        for (const [id, value] of evaluateRow(row, compiled, snapshot.properties, ctx)) {
          values[id] = toCellValue(value, types.get(id) ?? 'text');
        }
        out = { ...row, values };
        this.rows.set(row, out);
      }
      return out;
    });
    return { ...snapshot, properties, rows };
  }
}

/** Check a formula against a database's properties: its type, or an error with a position. */
export function checkFormula(
  source: string,
  properties: readonly Property[],
  selfId?: string,
): { type: FType; error: null } | { type: null; error: FormulaError } {
  try {
    const node = parse(source);
    const others = properties.filter((p) => p.id !== selfId);
    const compiled = compileFormulas(others);
    const byName = new Map<string, Property>();
    for (const p of others) if (!byName.has(p.name)) byName.set(p.name, p);
    const self = properties.find((p) => p.id === selfId);
    for (const ref of propRefs(node)) {
      if (self && ref.name === self.name) {
        throw new FormulaError('A formula can’t refer to itself', ref.span);
      }
      const target = byName.get(ref.name);
      // Catch cycles through other formulas.
      if (
        target?.type === 'formula' &&
        selfId &&
        dependsOnFormula(compiled, target.id, self?.name ?? '', byName)
      ) {
        throw new FormulaError(`Circular reference through "${target.name}"`, ref.span);
      }
    }
    const type = check(node, {
      prop: (name) => {
        const p = byName.get(name);
        if (!p) return undefined;
        if (p.type !== 'formula') return propertyFType(p);
        const entry = compiled.byId.get(p.id);
        return entry && !entry.error ? entry.type : T.any;
      },
    });
    return { type, error: null };
  } catch (error) {
    if (error instanceof FormulaError) return { type: null, error };
    throw error;
  }
}

/** Whether formula `id` (transitively) reads the property named `name`. */
function dependsOnFormula(
  compiled: CompiledFormulas,
  id: string,
  name: string,
  byName: ReadonlyMap<string, Property>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const entry = compiled.byId.get(id);
  if (!entry?.node) return false;
  for (const ref of propRefs(entry.node)) {
    if (ref.name === name) return true;
    const p = byName.get(ref.name);
    if (p?.type === 'formula' && dependsOnFormula(compiled, p.id, name, byName, seen)) return true;
  }
  return false;
}

/** Evaluate a formula for one row (the editor's live preview). */
export function previewFormula(
  source: string,
  row: Row | undefined,
  snapshot: DatabaseSnapshot,
  ctx: DisplayContext,
  selfId?: string,
): { value: FValue; type: FType } | { error: FormulaError } {
  const checked = checkFormula(source, snapshot.properties, selfId);
  if (checked.error) return { error: checked.error };
  if (!row) return { value: null, type: checked.type };
  const temp: Property = {
    id: '__preview__',
    name: '__preview__',
    type: 'formula',
    config: { expression: source },
    sortKey: '',
  };
  const properties = [...snapshot.properties.filter((p) => p.id !== selfId), temp];
  try {
    const compiled = compileFormulas(properties);
    const values = evaluateRow(row, compiled, properties, ctx);
    // Evaluate directly to surface runtime errors.
    const node = parse(source);
    const byName = new Map(properties.map((p) => [p.name, p]));
    const value = evaluate(node, {
      prop: (name) => {
        const p = byName.get(name);
        if (!p) return null;
        return p.type === 'formula' ? (values.get(p.id) ?? null) : propertyFValue(row, p, ctx);
      },
      page: { id: row.id, title: row.title },
      now: ctx.now ?? Date.now(),
    });
    return { value, type: checked.type };
  } catch (error) {
    if (error instanceof FormulaError) return { error };
    throw error;
  }
}

/** Rewrite `prop("old")` references after a property is renamed. */
export function renameInFormula(source: string, oldName: string, newName: string): string {
  let node: Node;
  try {
    node = parse(source);
  } catch {
    return source;
  }
  const refs = propRefs(node)
    .filter((r) => r.name === oldName)
    .sort((a, b) => b.span.start - a.span.start);
  let out = source;
  for (const ref of refs) {
    out = `${out.slice(0, ref.span.start)}"${newName.replace(/["\\]/g, '\\$&')}"${out.slice(ref.span.end)}`;
  }
  return out;
}

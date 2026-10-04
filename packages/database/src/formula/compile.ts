import type { Node } from './parser';
import { FUNCTIONS, type CallContext, type FnDef } from './stdlib';
import {
  FormulaError,
  T,
  assignable,
  elementType,
  typeName,
  unify,
  type FType,
  type FValue,
  type Span,
} from './types';
import { compareValues, formatValue, valuesEqual } from './values';

// --- Parameter specs ----------------------------------------------------------------------

interface Param {
  type: FType;
  optional: boolean;
  variadic: boolean;
  lambda: boolean;
}

function parseType(spec: string): FType {
  const list = /^list(?:<(.+)>)?$/.exec(spec);
  if (list) return T.list(list[1] ? parseType(list[1]) : T.any);
  return { kind: spec as Exclude<FType['kind'], 'list'> };
}

function parseParam(spec: string): Param {
  const variadic = spec.startsWith('...');
  const optional = spec.endsWith('?');
  const core = spec.replace(/^\.\.\./, '').replace(/\?$/, '');
  const lambda = /^lambda(?:<(.+)>)?$/.exec(core);
  return {
    type: lambda ? (lambda[1] ? parseType(lambda[1]) : T.any) : parseType(core),
    optional,
    variadic,
    lambda: !!lambda,
  };
}

const paramCache = new Map<string, Param[]>();
const paramsOf = (fn: FnDef) => {
  let params = paramCache.get(fn.name);
  if (!params) {
    params = fn.params.map(parseParam);
    paramCache.set(fn.name, params);
  }
  return params;
};

function checkArity(fn: FnDef, count: number, span: Span): void {
  const params = paramsOf(fn);
  const required = params.filter((p) => !p.optional && !p.variadic).length;
  const max = params.some((p) => p.variadic) ? Infinity : params.length;
  if (count < required || count > max) {
    const expected =
      max === Infinity
        ? `at least ${required}`
        : required === max
          ? String(max)
          : `${required} to ${max}`;
    throw new FormulaError(
      `${fn.name}() takes ${expected} argument${expected === '1' ? '' : 's'}, not ${count}`,
      span,
    );
  }
}

const paramAt = (fn: FnDef, i: number): Param => {
  const params = paramsOf(fn);
  return params[Math.min(i, params.length - 1)]!;
};

// --- Type checking ----------------------------------------------------------------------

export interface CheckEnv {
  /** Type of a property by name; `undefined` if there is none. */
  prop(name: string): FType | undefined;
}

/** Infer the type of a formula, or throw a `FormulaError` at the offending part. */
export function check(node: Node, env: CheckEnv, vars = new Map<string, FType>()): FType {
  const infer = (n: Node, scope: Map<string, FType>): FType => {
    switch (n.type) {
      case 'number':
        return T.number;
      case 'string':
        return T.text;
      case 'boolean':
        return T.boolean;
      case 'list':
        return T.list(n.items.map((i) => infer(i, scope)).reduce(unify, T.empty));
      case 'ident': {
        const t = scope.get(n.name);
        if (t) return t;
        if (n.name === 'current' || n.name === 'index') {
          throw new FormulaError(
            `"${n.name}" only works inside map, filter and similar functions`,
            n.span,
          );
        }
        if (FUNCTIONS.has(n.name))
          throw new FormulaError(`${n.name} needs parentheses: ${n.name}()`, n.span);
        throw new FormulaError(`Unknown name "${n.name}"`, n.span);
      }
      case 'unary': {
        const t = infer(n.operand, scope);
        const want = n.op === '-' ? T.number : T.boolean;
        if (!assignable(t, want)) {
          throw new FormulaError(
            `"${n.op}" needs a ${typeName(want)}, not ${typeName(t)}`,
            n.operand.span,
          );
        }
        return want;
      }
      case 'binary': {
        const l = infer(n.left, scope);
        const r = infer(n.right, scope);
        switch (n.op) {
          case '+':
            if (l.kind === 'text' || r.kind === 'text') return T.text;
            if (assignable(l, T.number) && assignable(r, T.number)) {
              return l.kind === 'any' || r.kind === 'any' ? T.any : T.number;
            }
            throw new FormulaError(`Can't add ${typeName(l)} and ${typeName(r)}`, n.span);
          case '-':
          case '*':
          case '/':
          case '%':
          case '^':
            for (const [t, side] of [
              [l, n.left],
              [r, n.right],
            ] as const) {
              if (!assignable(t, T.number)) {
                throw new FormulaError(`"${n.op}" needs numbers, not ${typeName(t)}`, side.span);
              }
            }
            return T.number;
          case 'and':
          case 'or':
            for (const [t, side] of [
              [l, n.left],
              [r, n.right],
            ] as const) {
              if (!assignable(t, T.boolean)) {
                throw new FormulaError(`"${n.op}" needs booleans, not ${typeName(t)}`, side.span);
              }
            }
            return T.boolean;
          case '<':
          case '<=':
          case '>':
          case '>=':
            if (
              l.kind !== 'any' &&
              r.kind !== 'any' &&
              l.kind !== 'empty' &&
              r.kind !== 'empty' &&
              l.kind !== r.kind
            ) {
              throw new FormulaError(`Can't compare ${typeName(l)} with ${typeName(r)}`, n.span);
            }
            return T.boolean;
          default:
            return T.boolean;
        }
      }
      case 'ternary': {
        const test = infer(n.test, scope);
        if (!assignable(test, T.boolean))
          throw new FormulaError('The condition must be a boolean', n.test.span);
        return unify(infer(n.then, scope), infer(n.otherwise, scope));
      }
      case 'call':
        return inferCall(n, scope);
    }
  };

  const inferCall = (n: Extract<Node, { type: 'call' }>, scope: Map<string, FType>): FType => {
    if (n.name === 'prop') {
      const arg = n.args[0];
      if (n.args.length !== 1 || arg?.type !== 'string') {
        throw new FormulaError('prop() takes the name of a property in quotes', n.span);
      }
      const t = env.prop(arg.value);
      if (!t) throw new FormulaError(`No property named "${arg.value}"`, arg.span);
      return t;
    }
    if (n.name === 'let' || n.name === 'lets') {
      if (
        n.args.length < 3 ||
        n.args.length % 2 === 0 ||
        (n.name === 'let' && n.args.length !== 3)
      ) {
        throw new FormulaError(`${n.name}() takes names and values, then an expression`, n.span);
      }
      const inner = new Map(scope);
      for (let i = 0; i + 1 < n.args.length; i += 2) {
        const name = n.args[i]!;
        if (name.type !== 'ident') throw new FormulaError('Expected a name', name.span);
        inner.set(name.name, infer(n.args[i + 1]!, inner));
      }
      return infer(n.args[n.args.length - 1]!, inner);
    }
    const fn = FUNCTIONS.get(n.name);
    if (!fn) throw new FormulaError(`Unknown function "${n.name}"`, n.nameSpan);
    checkArity(fn, n.args.length, n.span);
    const types: FType[] = [];
    n.args.forEach((arg, i) => {
      const param = paramAt(fn, i);
      let t: FType;
      if (param.lambda) {
        const inner = new Map(scope);
        inner.set('current', elementType(types[0] ?? T.any));
        inner.set('index', T.number);
        t = infer(arg, inner);
      } else t = infer(arg, scope);
      if (!assignable(t, param.type)) {
        throw new FormulaError(
          `${fn.name}() needs a ${typeName(param.type)} here, not ${typeName(t)}`,
          arg.span,
        );
      }
      types.push(t);
    });
    return typeof fn.returns === 'function' ? fn.returns(types) : fn.returns;
  };

  return infer(node, vars);
}

// --- Evaluation ---------------------------------------------------------------------------

export interface EvalEnv {
  prop(name: string): FValue;
  page: { id: string; title: string };
  now: number;
}

const toNumber = (v: FValue, span: Span): number => {
  if (v === null) return 0;
  if (typeof v !== 'number')
    throw new FormulaError(`Expected a number, got ${formatValue(v)}`, span);
  return v;
};
const toBoolean = (v: FValue): boolean => v === true;

/** Evaluate a (checked) formula for one row. */
export function evaluate(node: Node, env: EvalEnv, vars = new Map<string, FValue>()): FValue {
  const ev = (n: Node, scope: Map<string, FValue>): FValue => {
    switch (n.type) {
      case 'number':
      case 'string':
      case 'boolean':
        return n.value;
      case 'list':
        return n.items.map((i) => ev(i, scope));
      case 'ident':
        if (!scope.has(n.name)) throw new FormulaError(`Unknown name "${n.name}"`, n.span);
        return scope.get(n.name)!;
      case 'unary': {
        const v = ev(n.operand, scope);
        return n.op === '-' ? -toNumber(v, n.operand.span) : !toBoolean(v);
      }
      case 'ternary':
        return toBoolean(ev(n.test, scope)) ? ev(n.then, scope) : ev(n.otherwise, scope);
      case 'binary': {
        if (n.op === 'and') return toBoolean(ev(n.left, scope)) && toBoolean(ev(n.right, scope));
        if (n.op === 'or') return toBoolean(ev(n.left, scope)) || toBoolean(ev(n.right, scope));
        const l = ev(n.left, scope);
        const r = ev(n.right, scope);
        switch (n.op) {
          case '+':
            if (typeof l === 'string' || typeof r === 'string')
              return formatValue(l) + formatValue(r);
            return toNumber(l, n.left.span) + toNumber(r, n.right.span);
          case '-':
            return toNumber(l, n.left.span) - toNumber(r, n.right.span);
          case '*':
            return toNumber(l, n.left.span) * toNumber(r, n.right.span);
          case '/':
            return toNumber(l, n.left.span) / toNumber(r, n.right.span);
          case '%':
            return toNumber(l, n.left.span) % toNumber(r, n.right.span);
          case '^':
            return toNumber(l, n.left.span) ** toNumber(r, n.right.span);
          case '==':
            return valuesEqual(l, r);
          case '!=':
            return !valuesEqual(l, r);
          case '<':
            return l !== null && r !== null && compareValues(l, r) < 0;
          case '<=':
            return l !== null && r !== null && compareValues(l, r) <= 0;
          case '>':
            return l !== null && r !== null && compareValues(l, r) > 0;
          case '>=':
            return l !== null && r !== null && compareValues(l, r) >= 0;
        }
        return null;
      }
      case 'call':
        return call(n, scope);
    }
  };

  const call = (n: Extract<Node, { type: 'call' }>, scope: Map<string, FValue>): FValue => {
    if (n.name === 'prop') return env.prop((n.args[0] as { value: string }).value);
    if (n.name === 'let' || n.name === 'lets') {
      const inner = new Map(scope);
      for (let i = 0; i + 1 < n.args.length; i += 2) {
        inner.set((n.args[i] as { name: string }).name, ev(n.args[i + 1]!, inner));
      }
      return ev(n.args[n.args.length - 1]!, inner);
    }
    const fn = FUNCTIONS.get(n.name);
    if (!fn) throw new FormulaError(`Unknown function "${n.name}"`, n.nameSpan);
    const cache = new Map<number, FValue>();
    const context: CallContext = {
      count: n.args.length,
      value: (i) => {
        if (!cache.has(i)) cache.set(i, ev(n.args[i]!, scope));
        return cache.get(i)!;
      },
      lambda: (i, current, index) => {
        const inner = new Map(scope);
        inner.set('current', current);
        inner.set('index', index);
        return ev(n.args[i]!, inner);
      },
      fail: (message) => {
        throw new FormulaError(message, n.span);
      },
      page: env.page,
      now: env.now,
    };
    const result = fn.run(context);
    return typeof result === 'number' && Number.isNaN(result) ? null : result;
  };

  return ev(node, vars);
}

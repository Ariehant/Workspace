import { tokenize, type Token } from './lexer';
import { FormulaError, type Span } from './types';

export type Node =
  | { type: 'number'; value: number; span: Span }
  | { type: 'string'; value: string; span: Span }
  | { type: 'boolean'; value: boolean; span: Span }
  | { type: 'list'; items: Node[]; span: Span }
  | { type: 'ident'; name: string; span: Span }
  | { type: 'call'; name: string; args: Node[]; span: Span; nameSpan: Span; method: boolean }
  | { type: 'unary'; op: '-' | '!'; operand: Node; span: Span }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node; span: Span }
  | { type: 'ternary'; test: Node; then: Node; otherwise: Node; span: Span };

export type BinaryOp =
  '+' | '-' | '*' | '/' | '%' | '^' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';

/** Binding power of infix operators (higher binds tighter). */
const INFIX: Record<string, { power: number; op: BinaryOp; right?: boolean }> = {
  '||': { power: 2, op: 'or' },
  or: { power: 2, op: 'or' },
  '&&': { power: 3, op: 'and' },
  and: { power: 3, op: 'and' },
  '==': { power: 5, op: '==' },
  '!=': { power: 5, op: '!=' },
  '<': { power: 6, op: '<' },
  '<=': { power: 6, op: '<=' },
  '>': { power: 6, op: '>' },
  '>=': { power: 6, op: '>=' },
  '+': { power: 7, op: '+' },
  '-': { power: 7, op: '-' },
  '*': { power: 8, op: '*' },
  '/': { power: 8, op: '/' },
  '%': { power: 8, op: '%' },
  '^': { power: 10, op: '^', right: true },
};
const TERNARY_POWER = 1;
const UNARY_POWER = 9;

/** Parse formula text into a syntax tree. Throws `FormulaError` with a position. */
export function parse(source: string): Node {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;
  const span = (start: number, end: number): Span => ({ start, end });
  const fail = (message: string, token: Token): never => {
    throw new FormulaError(message, span(token.start, Math.max(token.end, token.start + 1)));
  };
  const expect = (value: string): Token => {
    const token = peek();
    if (token.value !== value || token.type === 'string') {
      fail(
        token.type === 'eof'
          ? `Expected "${value}"`
          : `Expected "${value}" but found "${token.value}"`,
        token,
      );
    }
    return next();
  };

  const args = (): { args: Node[]; end: number } => {
    expect('(');
    const list: Node[] = [];
    if (peek().value !== ')' || peek().type === 'string') {
      do list.push(expression(0));
      while (peek().value === ',' && peek().type === 'punct' && next());
    }
    return { args: list, end: expect(')').end };
  };

  const prefix = (): Node => {
    const token = next();
    switch (token.type) {
      case 'number':
        return { type: 'number', value: Number(token.value), span: span(token.start, token.end) };
      case 'string':
        return { type: 'string', value: token.value, span: span(token.start, token.end) };
      case 'ident': {
        if (token.value === 'true' || token.value === 'false') {
          return {
            type: 'boolean',
            value: token.value === 'true',
            span: span(token.start, token.end),
          };
        }
        if (token.value === 'not') {
          const operand = expression(UNARY_POWER);
          return { type: 'unary', op: '!', operand, span: span(token.start, operand.span.end) };
        }
        if (peek().value === '(' && peek().type === 'punct') {
          const call = args();
          return {
            type: 'call',
            name: token.value,
            args: call.args,
            span: span(token.start, call.end),
            nameSpan: span(token.start, token.end),
            method: false,
          };
        }
        return { type: 'ident', name: token.value, span: span(token.start, token.end) };
      }
      case 'op':
        if (token.value === '-' || token.value === '!') {
          const operand = expression(UNARY_POWER);
          return {
            type: 'unary',
            op: token.value,
            operand,
            span: span(token.start, operand.span.end),
          };
        }
        if (token.value === '+') return expression(UNARY_POWER);
        return fail(`Unexpected "${token.value}"`, token);
      case 'punct':
        if (token.value === '(') {
          const inner = expression(0);
          const close = expect(')');
          return { ...inner, span: span(token.start, close.end) };
        }
        if (token.value === '[') {
          const items: Node[] = [];
          if (peek().value !== ']' || peek().type === 'string') {
            do items.push(expression(0));
            while (peek().value === ',' && peek().type === 'punct' && next());
          }
          const close = expect(']');
          return { type: 'list', items, span: span(token.start, close.end) };
        }
        return fail(`Unexpected "${token.value}"`, token);
      case 'eof':
        return fail('Unexpected end of formula', token);
    }
  };

  const expression = (minPower: number): Node => {
    let left = prefix();
    for (;;) {
      const token = peek();
      // Method call: value.fn(args) means fn(value, args).
      if (token.type === 'punct' && token.value === '.') {
        next();
        const name = next();
        if (name.type !== 'ident') fail('Expected a function name after "."', name);
        if (peek().value !== '(') fail(`Expected "(" after ${name.value}`, peek());
        const call = args();
        left = {
          type: 'call',
          name: name.value,
          args: [left, ...call.args],
          span: span(left.span.start, call.end),
          nameSpan: span(name.start, name.end),
          method: true,
        };
        continue;
      }
      if (token.type === 'op' && token.value === '?') {
        if (TERNARY_POWER < minPower) break;
        next();
        const then = expression(0);
        expect(':');
        const otherwise = expression(TERNARY_POWER);
        left = {
          type: 'ternary',
          test: left,
          then,
          otherwise,
          span: span(left.span.start, otherwise.span.end),
        };
        continue;
      }
      const infix = (token.type === 'op' || token.type === 'ident') && INFIX[token.value];
      // Operators at least as strong as `minPower` continue this expression.
      if (!infix || infix.power < minPower) break;
      next();
      const right = expression(infix.right ? infix.power : infix.power + 1);
      left = {
        type: 'binary',
        op: infix.op,
        left,
        right,
        span: span(left.span.start, right.span.end),
      };
    }
    return left;
  };

  const tree = expression(0);
  if (peek().type !== 'eof') fail(`Unexpected "${peek().value}"`, peek());
  return tree;
}

/** Every `prop("Name")` in a tree, with the span of its string. */
export function propRefs(node: Node): { name: string; span: Span }[] {
  const refs: { name: string; span: Span }[] = [];
  const walk = (n: Node) => {
    if (n.type === 'call' && n.name === 'prop' && n.args[0]?.type === 'string') {
      refs.push({ name: n.args[0].value, span: n.args[0].span });
    }
    if (n.type === 'list') n.items.forEach(walk);
    if (n.type === 'call') n.args.forEach(walk);
    if (n.type === 'unary') walk(n.operand);
    if (n.type === 'binary') {
      walk(n.left);
      walk(n.right);
    }
    if (n.type === 'ternary') {
      walk(n.test);
      walk(n.then);
      walk(n.otherwise);
    }
  };
  walk(node);
  return refs;
}

/**
 * A small XML parser for machine-written documents (Word's `.docx` parts): elements,
 * attributes, text, self-closing tags, entities and CDATA. Declarations, processing
 * instructions, comments and doctypes are skipped. Names keep their prefixes (`w:p`).
 *
 * It's lenient rather than validating: a stray close tag is ignored, and unclosed elements end
 * with the document.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parse a document; returns its root element (an empty one if there's none). */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1]!;
  const text = (s: string) => {
    if (s) top().children.push(decodeEntities(s));
  };
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      text(source.slice(i));
      break;
    }
    text(source.slice(i, lt));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? source.length : end + 3;
    } else if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const data = source.slice(lt + 9, end < 0 ? source.length : end);
      if (data) top().children.push(data);
      i = end < 0 ? source.length : end + 3;
    } else if (source[lt + 1] === '?' || source[lt + 1] === '!') {
      const end = source.indexOf('>', lt);
      i = end < 0 ? source.length : end + 1;
    } else if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt);
      const name = source.slice(lt + 2, end < 0 ? source.length : end).trim();
      // Close the nearest open element of that name (and any left open inside it).
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]!.name === name) {
          stack.length = s;
          break;
        }
      }
      i = end < 0 ? source.length : end + 1;
    } else {
      // A start tag: find its end outside quoted attribute values.
      let j = lt + 1;
      let quote: string | null = null;
      for (; j < source.length; j++) {
        const c = source[j];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      const inner = source.slice(lt + 1, j);
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const nameEnd = body.search(/[\s/]|$/);
      const name = body.slice(0, nameEnd);
      const attrs: Record<string, string> = {};
      for (const m of body.slice(nameEnd).matchAll(ATTR)) {
        attrs[m[1]!] = decodeEntities(m[2] ?? m[3] ?? '');
      }
      const element: XmlElement = { name, attrs, children: [] };
      top().children.push(element);
      if (!selfClosing) stack.push(element);
      i = j + 1;
    }
  }
  return root;
}

export const isElement = (node: XmlNode): node is XmlElement => typeof node !== 'string';

/** The element children of `el` (named `name`, if given). */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter(
    (c): c is XmlElement => isElement(c) && (name === undefined || c.name === name),
  );
}

/** The first child element named `name`. */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c): c is XmlElement => isElement(c) && c.name === name);
}

/** Every descendant element named `name`, in document order. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (!isElement(c)) continue;
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/** The text inside an element (all of it, in order). */
export function textContent(el: XmlElement): string {
  return el.children.map((c) => (isElement(c) ? textContent(c) : c)).join('');
}

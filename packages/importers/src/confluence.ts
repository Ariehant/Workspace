import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { ImportBuilder } from './build';
import { htmlBlocks } from './html';
import type { ImportOptions, ImportReport, ImportTarget } from './import';
import type { LinkTarget } from './markdown';
import { basename, mimeOf, resolvePath, type ArchiveFile } from './paths';

/**
 * Confluence's HTML space export (Space settings → Export space → HTML): a page for the space
 * with its page tree under it, each page's content with its images and attachments, and links
 * between pages pointing at the new pages.
 */

type Node = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];
type Parent = DefaultTreeAdapterMap['parentNode'];

const isElement = (node: Node | Parent): node is Element => 'tagName' in node;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? null;
const kids = (el: Parent): Node[] => el.childNodes ?? [];

function find(root: Parent, test: (el: Element) => boolean): Element | null {
  for (const child of kids(root)) {
    if (!isElement(child)) continue;
    if (test(child)) return child;
    const inner = find(child, test);
    if (inner) return inner;
  }
  return null;
}

function findAll(root: Parent, test: (el: Element) => boolean, out: Element[] = []): Element[] {
  for (const child of kids(root)) {
    if (!isElement(child)) continue;
    if (test(child)) out.push(child);
    findAll(child, test, out);
  }
  return out;
}

function textOf(node: Node | Parent): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value;
  return kids(node as Parent)
    .map(textOf)
    .join('');
}

const byId = (id: string) => (el: Element) => attr(el, 'id') === id;
const decoder = new TextDecoder();

/** Is this a Confluence HTML export? (A page with Confluence's title and content blocks.) */
export function isConfluenceExport(files: readonly ArchiveFile[]): boolean {
  return files.some((f) => {
    if (!/\.html?$/i.test(f.path) || /(^|\/)index\.html$/i.test(f.path)) return false;
    const head = decoder.decode(f.data.subarray(0, 200_000));
    return /id="main-content"/.test(head) && /id="title-text"/.test(head);
  });
}

/** Confluence's code macro names its language ("brush: py"). */
const BRUSHES: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  ps: 'powershell',
  yml: 'yaml',
  text: 'plaintext',
  plain: 'plaintext',
  'c#': 'csharp',
  'c++': 'cpp',
};
const MACRO_ICONS: Record<string, string> = {
  information: 'ℹ️',
  note: '⚠️',
  warning: '❗',
  tip: '✅',
};

const classList = (el: Element) => (attr(el, 'class') ?? '').split(/\s+/).filter(Boolean);
const setAttr = (el: Element, name: string, value: string) => {
  el.attrs = [...el.attrs.filter((a) => a.name !== name), { name, value }];
};
/** An element made from HTML, to put into the tree. */
function element(html: string, parent: Element): Node {
  const node = parseFragment(html).childNodes[0]!;
  (node as Element).parentNode = parent;
  return node;
}

/**
 * Confluence's macros as the markup the converter knows: info, note, warning and tip panels as
 * callouts; code macros as code with their language; task lists as to-do lists; images on
 * their own line as image blocks.
 */
function tidy(main: Element): void {
  for (const el of findAll(main, () => true)) {
    const cls = classList(el);
    const macro = cls.find((c) => c.startsWith('confluence-information-macro-'));
    if (cls.includes('confluence-information-macro') && macro) {
      const kind = macro.slice('confluence-information-macro-'.length);
      const body = find(el, (e) => classList(e).includes('confluence-information-macro-body'));
      const title = find(el, (e) => classList(e).includes('title'));
      const content = body ? kids(body) : [];
      el.tagName = el.nodeName = 'aside' as never;
      el.attrs = [{ name: 'class', value: 'callout' }];
      const icon = element(`<span class="icon">${MACRO_ICONS[kind] ?? '💡'}</span>`, el);
      const holder = element('<div></div>', el) as Element;
      holder.childNodes = [
        ...(title ? [element(`<p><strong></strong></p>`, holder)] : []),
        ...content,
      ];
      if (title) {
        const strong = find(holder.childNodes[0] as Element, (e) => e.tagName === 'strong')!;
        strong.childNodes = kids(title);
      }
      for (const child of holder.childNodes) (child as Element).parentNode = holder;
      el.childNodes = [icon, holder];
    } else if (el.tagName === 'p' && !textOf(el).trim() && find(el, (e) => e.tagName === 'img')) {
      // An embedded image (in its wrapper) on its own line: the image block.
      el.tagName = el.nodeName = 'div' as never;
      el.childNodes = findAll(el, (e) => e.tagName === 'img');
      for (const img of el.childNodes) (img as Element).parentNode = el;
    } else if (el.tagName === 'pre' && attr(el, 'data-syntaxhighlighter-params')) {
      const brush = /brush:\s*([^;]+)/.exec(attr(el, 'data-syntaxhighlighter-params')!)?.[1];
      const lang = brush?.trim().toLowerCase();
      if (lang) setAttr(el, 'class', `language-${BRUSHES[lang] ?? lang}`);
    } else if (el.tagName === 'ul' && cls.includes('inline-task-list')) {
      setAttr(el, 'class', 'to-do-list');
      for (const li of kids(el).filter((n): n is Element => isElement(n) && n.tagName === 'li')) {
        const box = element(
          `<span class="checkbox${classList(li).includes('checked') ? ' checkbox-on' : ''}"></span>`,
          li,
        );
        li.childNodes = [box, ...kids(li)];
      }
    }
  }
}

interface PageFile {
  path: string;
  title: string;
  /** The page it sits under (its path), from the breadcrumbs. */
  parentPath: string | null;
  /** The content's HTML. */
  content: string;
  /** Files in the page's "Attachments" section. */
  attachments: string[];
  id: string;
}

export function importConfluence(
  input: readonly ArchiveFile[],
  target: ImportTarget,
  options: ImportOptions,
): ImportReport {
  const build = new ImportBuilder(target, options);
  // Drop a wrapping folder (the space key, or a zip's folder).
  const files = new Map(input.map((f) => [f.path.replace(/\\/g, '/').replace(/^\/+/, ''), f.data]));
  const tops = new Set([...files.keys()].map((p) => (p.includes('/') ? p.split('/')[0] : '')));
  if (tops.size === 1 && !tops.has('')) {
    const prefix = `${[...tops][0]!}/`;
    for (const [path, data] of [...files]) {
      files.delete(path);
      files.set(path.slice(prefix.length), data);
    }
  }
  const html = (path: string) => decoder.decode(files.get(path)!);

  // The space: its name (index.html's title) and the order of its pages ("Available Pages").
  let spaceName = options.title;
  const order: string[] = [];
  const treeParent = new Map<string, string | null>();
  if (files.has('index.html')) {
    const doc = parse(html('index.html'));
    const title = find(doc, byId('title-text')) ?? find(doc, (e) => e.tagName === 'title');
    if (title) spaceName = textOf(title).trim() || spaceName;
    // The section's list is the page tree (outside the section header that holds its title).
    const available = findAll(doc, (e) => /\bpageSection\b/.test(attr(e, 'class') ?? '')).find(
      (section) =>
        /available pages/i.test(textOf(find(section, (e) => e.tagName === 'h2') ?? section)),
    );
    const list = available
      ? (kids(available).find((n): n is Element => isElement(n) && n.tagName === 'ul') ??
        find(available, (e) => e.tagName === 'ul'))
      : null;
    const walk = (ul: Element, parent: string | null) => {
      for (const li of kids(ul).filter((n): n is Element => isElement(n) && n.tagName === 'li')) {
        const a = find(li, (e) => e.tagName === 'a');
        const href = a ? attr(a, 'href') : null;
        const path = href ? resolvePath('index.html', href) : null;
        if (path && files.has(path)) {
          order.push(path);
          treeParent.set(path, parent);
        }
        for (const inner of kids(li).filter(
          (n): n is Element => isElement(n) && n.tagName === 'ul',
        )) {
          walk(inner, path ?? parent);
        }
      }
    };
    if (list) walk(list, null);
  }

  // Every page.
  const pages = new Map<string, PageFile>();
  const names = new Map<string, string>();
  for (const path of files.keys()) {
    if (!/\.html?$/i.test(path) || path === 'index.html') continue;
    const doc = parse(html(path));
    const main = find(doc, byId('main-content'));
    if (!main) continue;
    tidy(main);
    const titleText = find(doc, byId('title-text'));
    let title = titleText ? textOf(titleText).replace(/\s+/g, ' ').trim() : basename(path);
    // "Space : Page" → "Page".
    if (title.startsWith(`${spaceName} : `)) title = title.slice(spaceName.length + 3);
    else title = title.replace(/^[^:]+ : /, '');
    const crumbs = find(doc, byId('breadcrumbs'));
    const crumbLinks = crumbs ? findAll(crumbs, (e) => e.tagName === 'a') : [];
    const lastCrumb = crumbLinks.at(-1);
    const crumbPath = lastCrumb ? resolvePath(path, attr(lastCrumb, 'href') ?? '') : null;
    // The "Attachments" section: its links name the files (the files are numbered).
    const section = findAll(doc, (e) => /\bpageSection\b/.test(attr(e, 'class') ?? '')).find(
      (s) => !!find(s, byId('attachments')),
    );
    const box = section ? find(section, (e) => /\bgreybox\b/.test(attr(e, 'class') ?? '')) : null;
    const attachments = box
      ? findAll(box, (e) => e.tagName === 'a').flatMap((a) => {
          const p = resolvePath(path, attr(a, 'href') ?? '');
          if (!p || !files.has(p)) return [];
          const name = textOf(a).trim();
          if (name) names.set(p, name);
          return [p];
        })
      : [];
    pages.set(path, {
      path,
      title,
      parentPath: crumbPath && crumbPath !== 'index.html' && crumbPath !== path ? crumbPath : null,
      content: serialize(main),
      attachments,
      id: '',
    });
  }

  // The tree: the index's order and nesting, else the breadcrumbs.
  const ordered = [
    ...order.filter((p) => pages.has(p)),
    ...[...pages.keys()].filter((p) => !order.includes(p)).sort(),
  ];
  const spaceId = build.page(spaceName);
  const visiting = new Set<string>();
  const create = (path: string): string => {
    const page = pages.get(path)!;
    if (page.id) return page.id;
    visiting.add(path);
    const parentPath = treeParent.has(path) ? treeParent.get(path)! : page.parentPath;
    const parentId =
      parentPath && pages.has(parentPath) && !visiting.has(parentPath) ? create(parentPath) : null;
    page.id = build.page(page.title, parentId ?? spaceId);
    visiting.delete(path);
    return page.id;
  };
  for (const path of ordered) create(path);

  // Content, with links between pages and the files.
  const stored = new Map<string, LinkTarget>();
  const fileLink = (path: string): LinkTarget => {
    let link = stored.get(path);
    if (!link) {
      link = build.file(files.get(path)!, names.get(path) ?? basename(path), mimeOf(path));
      stored.set(path, link);
    }
    return link;
  };
  let done = 0;
  for (const path of ordered) {
    const page = pages.get(path)!;
    const link = (href: string): LinkTarget | null => {
      if (/^[a-z]+:/i.test(href) || href.startsWith('#')) return null;
      const resolved = resolvePath(path, href);
      if (!resolved) return null;
      const other = pages.get(resolved);
      if (other) return { kind: 'page', id: other.id, title: other.title };
      if (files.has(resolved)) return fileLink(resolved);
      return /\.[a-z0-9]{1,5}$/i.test(resolved) ? { kind: 'missing' } : null;
    };
    const blocks = htmlBlocks(`<body>${page.content}</body>`, { link, warn: (m) => build.warn(m) });
    const shown = new Set(stored.keys());
    // Attachments the page doesn't show in its content.
    for (const attachment of page.attachments) {
      if (shown.has(attachment)) continue;
      const file = fileLink(attachment);
      if (file.kind === 'file') {
        blocks.push({ type: file.media, attrs: { fileId: file.fileId, name: file.name } });
      }
    }
    build.content(page.id, blocks);
    options.onProgress?.(++done, ordered.length);
  }
  return build.done();
}

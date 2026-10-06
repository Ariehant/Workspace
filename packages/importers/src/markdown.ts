import { parseMarkdown, type JSONContent } from '@workspace/editor';

/** What a link in an imported page points at. */
export type LinkTarget =
  | { kind: 'page'; id: string; title: string; database?: boolean }
  | {
      kind: 'file';
      fileId: string;
      name: string;
      media: 'image' | 'video' | 'audio' | 'pdf' | 'file';
    }
  /** A link into the archive that isn't there. */
  | { kind: 'missing' };

export interface ConvertContext {
  /** Resolve a link's href (relative to the page's file); null for external links. */
  link(href: string): LinkTarget | null;
  warn(message: string): void;
}

export interface ConvertedPage {
  title: string | null;
  /** `Property: value` lines under a row page's title. */
  properties: [string, string][];
  blocks: JSONContent[];
}

/** A link as people read it: decoded, and without Notion's ids. */
export function readable(href: string): string {
  let text = href;
  try {
    text = decodeURIComponent(href);
  } catch {
    // keep it as it is
  }
  return text.replace(/ ?[0-9a-f]{32}(?=[./]|$)/gi, '');
}

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const ICON = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u;

/** A media block for a stored file. */
function mediaBlock(target: Extract<LinkTarget, { kind: 'file' }>, caption = ''): JSONContent {
  const attrs: Record<string, unknown> = { fileId: target.fileId, name: target.name };
  if (target.media !== 'file' && caption && caption !== target.name) attrs.caption = caption;
  return { type: target.media, attrs };
}

const linkOf = (node: JSONContent) =>
  node.marks?.find((m) => m.type === 'link')?.attrs?.href as string | undefined;

/** Links between pages become mentions or page links, files become media blocks. */
function fixInline(content: JSONContent[], ctx: ConvertContext): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of content) {
    if (node.type !== 'text' || !node.text) {
      out.push(node);
      continue;
    }
    // `<br>` (line breaks in table cells and list items).
    const pieces = node.text.split(/<br\s*\/?>/i);
    pieces.forEach((text, i) => {
      if (i > 0) out.push({ type: 'hardBreak' });
      if (!text) return;
      const href = linkOf(node);
      const target = href ? ctx.link(href) : null;
      if (!target) {
        out.push({ ...node, text });
        return;
      }
      const marks = (node.marks ?? []).filter((m) => m.type !== 'link');
      if (target.kind === 'page') {
        if (text.trim() === target.title.trim() || !text.trim()) {
          out.push({ type: 'mention', attrs: { kind: 'page', pageId: target.id } });
        } else {
          out.push({
            ...node,
            text,
            marks: [...marks, { type: 'link', attrs: { href: `workspace://page/${target.id}` } }],
          });
        }
        return;
      }
      if (target.kind === 'missing')
        ctx.warn(`A link to a missing file was kept as text: ${readable(href!)}`);
      out.push({ type: 'text', text, ...(marks.length ? { marks } : {}) });
    });
  }
  return out;
}

/** Blocks after parsing: a paragraph that is only a link becomes a page link or a file. */
function fixBlocks(blocks: JSONContent[], ctx: ConvertContext): JSONContent[] {
  return blocks.map((block) => {
    if (block.type === 'paragraph' && block.content?.length === 1) {
      const only = block.content[0]!;
      const href = only.type === 'text' ? linkOf(only) : undefined;
      const target = href ? ctx.link(href) : null;
      if (target?.kind === 'page')
        return { type: target.database ? 'database' : 'pageLink', attrs: { pageId: target.id } };
      if (target?.kind === 'file') return mediaBlock(target, only.text);
    }
    if (block.type === 'codeBlock' || !block.content) return block;
    const inlineParent = block.content.some((c) => c.type === 'text' || c.type === 'mention');
    return {
      ...block,
      content: inlineParent ? fixInline(block.content, ctx) : fixBlocks(block.content, ctx),
    };
  });
}

/** Body Markdown (no title) to blocks, with Notion's `<aside>` callouts and image lines. */
export function notionBlocks(markdown: string, ctx: ConvertContext): JSONContent[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: JSONContent[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text) blocks.push(...fixBlocks(parseMarkdown(text), ctx));
  };
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      buffer.push(line);
      if (fenceMatch && fenceMatch[1]!.startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      buffer.push(line);
      continue;
    }
    if (line.trim() === '<aside>') {
      flush();
      const inner: string[] = [];
      let depth = 1;
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        if (l.trim() === '<aside>') depth++;
        if (l.trim() === '</aside>' && --depth === 0) break;
        inner.push(l);
      }
      let text = inner.join('\n').trim();
      const icon = ICON.exec(text);
      if (icon) text = text.slice(icon[0].length);
      const content = notionBlocks(text, ctx);
      blocks.push({
        type: 'callout',
        attrs: icon ? { icon: icon[1] } : {},
        content: content.length ? content : [{ type: 'paragraph' }],
      });
      continue;
    }
    const image = IMAGE_LINE.exec(line.trim());
    if (image) {
      const target = ctx.link(image[2]!);
      if (target?.kind === 'file') {
        flush();
        blocks.push(mediaBlock(target, image[1]));
        continue;
      }
      if (!target && /^https?:/i.test(image[2]!)) {
        flush();
        blocks.push({ type: 'image', attrs: { src: image[2], caption: image[1] || '' } });
        continue;
      }
      if (target?.kind === 'missing')
        ctx.warn(`An image wasn't in the export: ${readable(image[2]!)}`);
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

/**
 * A page from Notion's Markdown export: `# Title`, then (for database rows) property
 * lines, then the content.
 */
export function notionMarkdownPage(
  markdown: string,
  ctx: ConvertContext,
  options: { row?: boolean } = {},
): ConvertedPage {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  let title: string | null = null;
  const heading = /^#\s+(.*)$/.exec(lines[i] ?? '');
  if (heading) {
    title = heading[1]!.trim();
    i++;
  }
  const properties: [string, string][] = [];
  if (options.row) {
    while (i < lines.length && !lines[i]!.trim()) i++;
    const start = i;
    const props: [string, string][] = [];
    while (i < lines.length && lines[i]!.trim()) {
      const m = /^([^:\n]{1,100}):\s(.*)$/.exec(lines[i]!);
      if (!m) break;
      props.push([m[1]!.trim(), m[2]!.trim()]);
      i++;
    }
    // Only a block of property lines that ends the paragraph counts.
    if (props.length && (i >= lines.length || !lines[i]!.trim())) properties.push(...props);
    else i = start;
  }
  return { title, properties, blocks: notionBlocks(lines.slice(i).join('\n'), ctx) };
}

import { describe, expect, it } from 'vitest';
import {
  blockChangeIn,
  blocksIn,
  blocksOut,
  commentBodyIn,
  commentRichText,
  derivedId,
  findBlock,
  richTextIn,
  richTextOut,
  type BlockContext,
  type PMNode,
} from './index';

const ADA = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const ctx: BlockContext = {
  fileUrl: (id) => ({ url: `https://files.test/${id}`, expiry_time: '2026-01-01T00:00:00.000Z' }),
  pageTitle: (id) => (id === PAGE ? 'Gear plan' : null),
  userName: (id) => (id === ADA ? 'Ada' : null),
  pageUrl: (id) => `https://app.test/p/${id}`,
};
const write = { isUser: (id: string) => id === ADA };

const p = (id: string, text: string, extra: Partial<PMNode> = {}): PMNode => ({
  type: 'paragraph',
  attrs: { id },
  content: text ? [{ type: 'text', text }] : undefined,
  ...extra,
});

describe('rich text', () => {
  it('marks, links, colors, mentions, equations and line breaks, both ways', () => {
    const inline: PMNode[] = [
      {
        type: 'text',
        text: 'Bold',
        marks: [{ type: 'bold' }, { type: 'color', attrs: { color: 'red' } }],
      },
      { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://lab.io' } }] },
      { type: 'hardBreak' },
      { type: 'mention', attrs: { kind: 'user', userId: ADA } },
      { type: 'mention', attrs: { kind: 'page', pageId: PAGE } },
      { type: 'mention', attrs: { kind: 'date', date: '2026-10-12', reminder: false } },
      { type: 'inlineMath', attrs: { latex: 'E=mc^2' } },
    ];
    const out = richTextOut(inline, ctx);
    expect(out[0]).toMatchObject({ plain_text: 'Bold', annotations: { bold: true, color: 'red' } });
    expect(out[1]).toMatchObject({
      href: 'https://lab.io',
      text: { link: { url: 'https://lab.io' } },
    });
    expect(out.slice(3).map((i) => i.plain_text)).toEqual([
      '@Ada',
      'Gear plan',
      '2026-10-12',
      'E=mc^2',
    ]);
    const back = richTextIn(out, 'r', write);
    expect(back.filter((n) => n.type !== 'hardBreak')).toEqual(
      inline.filter((n) => n.type !== 'hardBreak').map((n) => (n.type === 'text' ? { ...n } : n)),
    );
    expect(() =>
      richTextIn([{ type: 'mention', mention: { type: 'user', user: { id: PAGE } } }], 'r', write),
    ).toThrow(/user of the workspace/);
    expect(() =>
      richTextIn([{ text: { content: 'x', link: { url: 'javascript:alert(1)' } } }], 'r', write),
    ).toThrow(/web address/);
  });

  it('comments keep mentions of people', () => {
    const rich = commentRichText(`Ask <@${ADA}> first`, ctx);
    expect(rich.map((r) => r.plain_text).join('')).toBe('Ask @Ada first');
    expect(commentBodyIn(rich, write)).toBe(`Ask <@${ADA}> first`);
    expect(() => commentBodyIn([], write)).toThrow(/some text/);
  });
});

describe('blocks', () => {
  const doc: PMNode[] = [
    { type: 'heading', attrs: { id: 'h1', level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
    p('p1', 'Intro'),
    {
      type: 'bulletList',
      attrs: { id: 'l1' },
      content: [
        {
          type: 'listItem',
          attrs: { id: 'i1' },
          content: [
            p('i1p', 'One'),
            {
              type: 'bulletList',
              attrs: { id: 'l2' },
              content: [{ type: 'listItem', attrs: { id: 'i3' }, content: [p('i3p', 'Nested')] }],
            },
          ],
        },
        { type: 'listItem', attrs: { id: 'i2' }, content: [p('i2p', 'Two')] },
      ],
    },
    {
      type: 'taskList',
      attrs: { id: 't1' },
      content: [
        { type: 'taskItem', attrs: { id: 'ti1', checked: true }, content: [p('tp', 'Done')] },
      ],
    },
    {
      type: 'details',
      attrs: { id: 'd1' },
      content: [
        { type: 'detailsSummary', attrs: { level: 1 }, content: [{ type: 'text', text: 'More' }] },
        { type: 'detailsContent', content: [p('dp', 'Hidden')] },
      ],
    },
    {
      type: 'details',
      attrs: { id: 'd2' },
      content: [
        { type: 'detailsSummary', content: [{ type: 'text', text: 'Toggle' }] },
        { type: 'detailsContent', content: [p('dp2', 'Inside')] },
      ],
    },
    { type: 'blockquote', attrs: { id: 'q1' }, content: [p('qp', 'Quoted')] },
    {
      type: 'callout',
      attrs: { id: 'c1', icon: '⚠️', color: 'yellow_background' },
      content: [p('cp', 'Careful')],
    },
    {
      type: 'codeBlock',
      attrs: { id: 'k1', language: 'cpp' },
      content: [{ type: 'text', text: 'int x;' }],
    },
    { type: 'horizontalRule', attrs: { id: 'hr' } },
    { type: 'blockMath', attrs: { id: 'm1', latex: 'a^2' } },
    {
      type: 'table',
      attrs: { id: 'tb' },
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [p('', 'Part')] },
            { type: 'tableHeader', content: [p('', 'Qty')] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p('', 'Servo')] },
            { type: 'tableCell', content: [p('', '4')] },
          ],
        },
      ],
    },
    {
      type: 'columnList',
      attrs: { id: 'cl' },
      content: [
        { type: 'column', attrs: { id: 'co1' }, content: [p('cp1', 'Left')] },
        { type: 'column', attrs: { id: 'co2' }, content: [p('cp2', 'Right')] },
      ],
    },
    { type: 'pageLink', attrs: { id: 'pl', pageId: PAGE } },
    { type: 'image', attrs: { id: 'im', fileId: 'f1.png', name: 'arm.png', caption: 'The arm' } },
    { type: 'bookmark', attrs: { id: 'bm', url: 'https://lab.io', title: 'Lab' } },
    { type: 'button', attrs: { id: 'bt', label: 'Go' } },
  ];

  it('come out as Notion blocks, lists taken apart', () => {
    const out = blocksOut(doc, ctx);
    expect(out.map((b) => b.type)).toEqual([
      'heading_2',
      'paragraph',
      'bulleted_list_item',
      'bulleted_list_item',
      'to_do',
      'heading_1',
      'toggle',
      'quote',
      'callout',
      'code',
      'divider',
      'equation',
      'table',
      'column_list',
      'link_to_page',
      'image',
      'bookmark',
      'unsupported',
    ]);
    expect(findBlock(out, 'i3')).toMatchObject({
      parent: 'i1',
      block: { type: 'bulleted_list_item' },
    });
    expect(findBlock(out, 'd1')!.block.value).toMatchObject({ is_toggleable: true });
    expect(findBlock(out, 'c1')!.block.value).toMatchObject({
      icon: { emoji: '⚠️' },
      color: 'yellow_background',
    });
    expect(findBlock(out, 'k1')!.block.value).toMatchObject({ language: 'c++' });
    const table = findBlock(out, 'tb')!.block;
    expect(table.value).toEqual({ table_width: 2, has_column_header: true, has_row_header: false });
    expect(table.children[1]!.id).toBe(derivedId('tb', 1));
    expect(table.children[1]!.id).toBe(derivedId('tb', 1));
    expect(findBlock(out, 'im')!.block.value).toMatchObject({
      type: 'file',
      file: { url: 'https://files.test/f1.png' },
      caption: [{ plain_text: 'The arm' }],
    });
  });

  it('go back in as the same content (ids aside)', () => {
    const out = blocksOut(doc.slice(0, -1), ctx);
    const json = JSON.parse(JSON.stringify(out, (k, v) => (k === 'id' ? undefined : v)));
    const asApi = (blocks: typeof json): unknown[] =>
      blocks.map((b: { type: string; value: Record<string, unknown>; children: unknown[] }) => ({
        type: b.type,
        [b.type]: { ...b.value, ...(b.children.length && { children: asApi(b.children) }) },
      }));
    // Images go in by URL (uploads aren't supported), so the stored one is left out.
    const sent = asApi(json).filter((b) => (b as { type: string }).type !== 'image');
    const back = blocksIn(sent, 'children', write, -10);
    const strip = (nodes: PMNode[]): unknown =>
      nodes.map((n) => ({
        type: n.type,
        ...(n.text && { text: n.text }),
        ...(n.content && { content: strip(n.content) }),
      }));
    const original = doc.filter((n) => n.type !== 'image' && n.type !== 'button');
    expect(strip(back)).toEqual(strip(original));
  });

  it('refuse what can’t be added, too deep or too many', () => {
    expect(() =>
      blocksIn([{ type: 'child_page', child_page: { title: 'x' } }], 'children', write),
    ).toThrow(/POST \/v1\/pages/);
    expect(() => blocksIn([{ type: 'sparkle', sparkle: {} }], 'children', write)).toThrow(
      /can't be added/,
    );
    const deep = {
      type: 'toggle',
      toggle: {
        rich_text: [],
        children: [
          {
            type: 'toggle',
            toggle: {
              rich_text: [],
              children: [{ type: 'toggle', toggle: { rich_text: [], children: [] } }],
            },
          },
        ],
      },
    };
    expect(() => blocksIn([deep], 'children', write)).toThrow(/2 levels/);
    expect(() =>
      blocksIn(
        Array.from({ length: 101 }, () => ({ type: 'divider', divider: {} })),
        'children',
        write,
      ),
    ).toThrow(/at most 100/);
    expect(() =>
      blocksIn([{ type: 'image', image: { type: 'file', file: { url: 'x' } } }], 'children', write),
    ).toThrow(/uploads/);
  });

  it('updates change the text and settings', () => {
    expect(
      blockChangeIn(
        'to_do',
        { to_do: { rich_text: [{ text: { content: 'Again' } }], checked: false } },
        write,
      ),
    ).toEqual({
      inline: [{ type: 'text', text: 'Again' }],
      attrs: { checked: false },
    });
    expect(blockChangeIn('code', { code: { language: 'c#' } }, write)).toEqual({
      attrs: { language: 'csharp' },
    });
  });
});

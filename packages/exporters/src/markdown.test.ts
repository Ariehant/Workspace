import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readContent } from './content';
import type { RenderContext } from './context';
import { blocksHtml } from './html';
import { blocksMarkdown } from './markdown';
import { el, marked, setContent } from './testing';

const ctx: RenderContext = {
  pageHref: (id) => `Other ${id}.md`,
  pageTitle: (id) => (id === 'p1' ? 'Gripper' : 'Untitled'),
  fileHref: (id, name) => `Page/${name ?? id}`,
  synced: () => [],
  mermaidSvg: (code) => (code.includes('graph') ? '<svg viewBox="0 0 10 10"></svg>' : null),
};

const md = (...blocks: Y.XmlElement[]) =>
  blocksMarkdown(readContent(setContent(new Y.Doc(), ...blocks)), ctx);

describe('Markdown export', () => {
  it('writes text blocks with marks, links, mentions and equations', () => {
    expect(
      md(
        el('heading', { level: 2 }, 'Arm'),
        el(
          'paragraph',
          {},
          'Use ',
          marked('bold', { bold: {} }),
          ' and ',
          marked('both ', { bold: {}, italic: {} }),
          marked('a*b', { code: {} }),
          ' see ',
          marked('docs', { link: { href: 'https://ros.org/a b' } }),
          ' ',
          el('mention', { kind: 'page', pageId: 'p1' }),
          ' on ',
          el('mention', { kind: 'date', date: '2026-10-06' }),
          ' ',
          el('inlineMath', { latex: 'x^2' }),
          ' 5*3',
        ),
        el('paragraph'),
        el('paragraph', {}, 'After a gap'),
      ),
    ).toBe(
      '## Arm\n\nUse **bold** and ***both*** `a*b` see [docs](https://ros.org/a%20b) ' +
        '[Gripper](Other%20p1.md) on @October 6, 2026 $x^2$ 5\\*3\n\nAfter a gap',
    );
  });

  it('writes lists (nested, numbered, to-dos), quotes, code, rules and equations', () => {
    expect(
      md(
        el(
          'bulletList',
          {},
          el(
            'listItem',
            {},
            el('paragraph', {}, 'a'),
            el('bulletList', {}, el('listItem', {}, el('paragraph', {}, 'nested'))),
          ),
          el('listItem', {}, el('paragraph', {}, 'b')),
        ),
        el('orderedList', { start: 3 }, el('listItem', {}, el('paragraph', {}, 'three'))),
        el(
          'taskList',
          {},
          el('taskItem', { checked: false }, el('paragraph', {}, 'todo')),
          el('taskItem', { checked: true }, el('paragraph', {}, 'done')),
        ),
        el('blockquote', {}, el('paragraph', {}, 'one'), el('paragraph', {}, 'two')),
        el('codeBlock', { language: 'python' }, 'print(1)\nprint(2)'),
        el('codeBlock', { language: 'plaintext' }, 'raw'),
        el('horizontalRule'),
        el('blockMath', { latex: 'E = mc^2' }),
      ),
    ).toBe(
      [
        '- a\n    - nested\n- b',
        '3. three',
        '- [ ] todo\n- [x] done',
        '> one\n>\n> two',
        '```python\nprint(1)\nprint(2)\n```',
        '```\nraw\n```',
        '---',
        '$$\nE = mc^2\n$$',
      ].join('\n\n'),
    );
  });

  it('writes callouts, toggles, tables, columns, page links and media', () => {
    expect(
      md(
        el('callout', { icon: '⚠️' }, el('paragraph', {}, 'Hot surface')),
        el(
          'details',
          {},
          el('detailsSummary', { level: 0 }, 'Specs'),
          el('detailsContent', {}, el('paragraph', {}, '2 Nm')),
        ),
        el(
          'table',
          {},
          el(
            'tableRow',
            {},
            el('tableHeader', {}, el('paragraph', {}, 'Joint')),
            el('tableHeader', {}, el('paragraph', {}, 'Limit')),
          ),
          el(
            'tableRow',
            {},
            el('tableCell', {}, el('paragraph', {}, 'J1')),
            el('tableCell', {}, el('paragraph', {}, 'a|b')),
          ),
        ),
        el(
          'columnList',
          {},
          el('column', {}, el('paragraph', {}, 'left')),
          el('column', {}, el('paragraph', {}, 'right')),
        ),
        el('pageLink', { pageId: 'p1' }),
        el('image', { fileId: 'abc.png', name: 'arm.png', caption: 'The arm' }),
        el('file', { fileId: 'f.pdf', name: 'spec.pdf' }),
        el('bookmark', { url: 'https://ros.org', title: 'ROS' }),
        el('button', { label: 'Go' }),
      ),
    ).toBe(
      [
        '<aside>\n⚠️ Hot surface\n</aside>',
        '- Specs\n    2 Nm',
        '| Joint | Limit |\n| --- | --- |\n| J1 | a\\|b |',
        'left\n\nright',
        '[Gripper](Other%20p1.md)',
        '![The arm](Page/arm.png)',
        '[spec.pdf](Page/spec.pdf)',
        '[ROS](https://ros.org)',
      ].join('\n\n'),
    );
  });
});

describe('HTML export', () => {
  it('escapes text, keeps marks and colors, and embeds Mermaid diagrams', () => {
    const doc = setContent(
      new Y.Doc(),
      el(
        'paragraph',
        { color: 'blue_background' },
        '<b>',
        marked('red', { color: { color: 'red' } }),
      ),
      el('codeBlock', { language: 'mermaid' }, 'graph TD; A-->B'),
      el('taskList', {}, el('taskItem', { checked: true }, el('paragraph', {}, 'done'))),
    );
    const html = blocksHtml(readContent(doc), ctx);
    expect(html).toContain('<p class="bg-blue">&lt;b&gt;<span class="color-red">red</span></p>');
    expect(html).toContain('<img class="diagram" alt="Diagram" src="data:image/svg+xml');
    expect(html).toContain('<summary>Mermaid source</summary>');
    expect(html).toContain('<input type="checkbox" disabled checked>');
  });
});

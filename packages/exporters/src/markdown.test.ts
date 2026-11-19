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
  userName: (id) => (id === 'u1' ? 'Ada *L*' : 'Someone'),
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

  it('writes custom emoji as their image, or their name without one', () => {
    const doc = setContent(
      new Y.Doc(),
      el(
        'paragraph',
        {},
        'Go ',
        el('customEmoji', { name: 'teamlogo', fileId: 'f1' }),
        ' ',
        el('customEmoji', { name: 'gone' }),
      ),
    );
    expect(blocksMarkdown(readContent(doc), ctx)).toBe(
      'Go ![:teamlogo:](Page/teamlogo.png) :gone:',
    );
    expect(blocksHtml(readContent(doc), ctx)).toContain(
      '<img class="emoji" src="Page/teamlogo.png" alt=":teamlogo:" title=":teamlogo:"> :gone:',
    );
  });

  it('writes person mentions as the person’s name', () => {
    const doc = setContent(
      new Y.Doc(),
      el(
        'paragraph',
        {},
        'Ask ',
        el('mention', { kind: 'person', userId: 'u1' }),
        ' or ',
        el('mention', { kind: 'person', userId: 'gone' }),
      ),
    );
    expect(blocksMarkdown(readContent(doc), ctx)).toBe('Ask @Ada \\*L\\* or @Someone');
    expect(blocksHtml(readContent(doc), ctx)).toContain(
      '<span class="mention person">@Ada *L*</span>',
    );
  });

  it('writes tabs one after another, each under its title', () => {
    const doc = setContent(
      new Y.Doc(),
      el(
        'tabs',
        {},
        el('tab', { title: 'Specs' }, el('paragraph', {}, 'Torque 2 Nm')),
        el('tab', { title: 'Tests' }, el('paragraph', {}, 'Bench run')),
      ),
    );
    expect(blocksMarkdown(readContent(doc), ctx)).toBe(
      '**Specs**\n\nTorque 2 Nm\n\n**Tests**\n\nBench run',
    );
    expect(blocksHtml(readContent(doc), ctx)).toBe(
      '<div class="tabs"><section class="tab"><h4 class="tab-title">Specs</h4><p>Torque 2 Nm</p></section><section class="tab"><h4 class="tab-title">Tests</h4><p>Bench run</p></section></div>',
    );
  });

  it('writes link mentions as links with their titles', () => {
    const doc = setContent(
      new Y.Doc(),
      el(
        'paragraph',
        {},
        'See ',
        el('mention', { kind: 'link', url: 'https://github.com/lab/arm/pull/7', title: 'PR #7' }),
        ' and ',
        el('mention', { kind: 'link', url: 'javascript:alert(1)', title: 'bad' }),
      ),
    );
    expect(blocksMarkdown(readContent(doc), ctx)).toBe(
      'See [PR #7](https://github.com/lab/arm/pull/7) and bad',
    );
    const html = blocksHtml(readContent(doc), ctx);
    expect(html).toContain(
      '<a class="mention link" href="https://github.com/lab/arm/pull/7">PR #7</a>',
    );
    expect(html).not.toContain('javascript:');
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

describe('linked files', () => {
  it('come out as their name and where they are, in Markdown and HTML', () => {
    const doc = setContent(
      new Y.Doc(),
      el('linkedFile', { folder: 'Projects', path: 'arm/v3_*.step', name: 'v3_*.step', size: 9 }),
      el('linkedFile', { folder: null, path: '/data/<run>.bag', name: '<run>.bag' }),
      // A pointer climbing out of its folder isn't one.
      el('linkedFile', { folder: 'Projects', path: '../x', name: 'x' }),
    );
    const content = readContent(doc);
    expect(blocksMarkdown(content, ctx)).toBe(
      '📎 v3\\_\\*.step (`Projects/arm/v3_*.step`)\n\n📎 <run>.bag (`/data/<run>.bag`)',
    );
    expect(blocksHtml(content, ctx).trimEnd()).toBe(
      '<p class="linked-file">📎 v3_*.step <code>Projects/arm/v3_*.step</code></p>\n' +
        '<p class="linked-file">📎 &lt;run&gt;.bag <code>/data/&lt;run&gt;.bag</code></p>',
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

  it('keeps the colours of a simple table’s cells', () => {
    const doc = setContent(
      new Y.Doc(),
      el(
        'table',
        {},
        el(
          'tableRow',
          {},
          el('tableHeader', { color: 'gray_background' }, el('paragraph', {}, 'Joint')),
          el('tableHeader', { color: 'gray_background' }, el('paragraph', {}, 'Limit')),
        ),
        el(
          'tableRow',
          {},
          el('tableCell', {}, el('paragraph', {}, 'J1')),
          el('tableCell', { color: 'red' }, el('paragraph', {}, '90°')),
        ),
      ),
    );
    expect(blocksHtml(readContent(doc), ctx)).toBe(
      '<table><tr><th class="bg-gray"><p>Joint</p></th><th class="bg-gray"><p>Limit</p></th></tr>' +
        '<tr><td><p>J1</p></td><td class="color-red"><p>90°</p></td></tr></table>',
    );
  });
});

describe('cropped images', () => {
  it('show their crop and turn in HTML, and the whole file in Markdown', () => {
    const doc = setContent(
      new Y.Doc(),
      el('image', {
        fileId: 'f1',
        name: 'arm.png',
        crop: '0.1 0.2 0.5 0.4',
        rotate: 90,
        aspect: 0.8,
      }),
      el('image', { fileId: 'f2', name: 'base.png' }),
    );
    const html = blocksHtml(readContent(doc), ctx);
    expect(html).toContain(
      '<div class="cropped" style="position:relative;overflow:hidden;width:100%;aspect-ratio:0.8">',
    );
    expect(html).toContain('transform:translate(-50%, -50%) rotate(90deg)');
    expect(html).toContain(
      '<img src="Page/arm.png" alt="arm.png" style="position:absolute;max-width:none;width:200%;height:250%;left:-20%;top:-50%">',
    );
    expect(html).toContain('<img src="Page/base.png" alt="base.png">');
    expect(blocksMarkdown(readContent(doc), ctx)).toContain('![arm.png](Page/arm.png)');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPage, listPages, readBlocks } from '@workspace/core';
import type { JSONContent } from '@workspace/editor';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MAX_DOCX_BYTES, nearestColor, readDocx, type DocxContext } from './docx';
import { importFiles, type ImportTarget } from './import';
import { childElements, parseXml, textContent } from './xml';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

/** A `.docx` from its parts: the document's body, and optional other parts. */
function docx(body: string, parts: Record<string, string | Uint8Array> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} xmlns:r="r" xmlns:a="a" xmlns:wp="wp"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ),
  };
  for (const [path, data] of Object.entries(parts)) {
    files[path] = typeof data === 'string' ? strToU8(data) : data;
  }
  return zipSync(files);
}

const p = (text: string, props = '', runProps = '') =>
  `<w:p><w:pPr>${props}</w:pPr><w:r><w:rPr>${runProps}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const styled = (style: string, text: string) => p(text, `<w:pStyle w:val="${style}"/>`);
const listed = (numId: number, level: number, text: string) =>
  p(text, `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);

const STYLES = `<w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/></w:style>
  <w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="Überschrift 2"/><w:basedOn w:val="Standard"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>
  <w:style w:type="paragraph" w:styleId="SourceCode"><w:name w:val="Source Code"/></w:style>
  <w:style w:type="character" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/><w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr></w:style>
</w:styles>`;

const NUMBERING = `<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

function read(data: Uint8Array) {
  const stored: { name: string; mime: string }[] = [];
  const warnings = new Set<string>();
  const ctx: DocxContext = {
    file: (_bytes, name, mime) => {
      stored.push({ name, mime });
      return { kind: 'file', fileId: `file-${name}`, name, media: 'image' };
    },
    warn: (m) => warnings.add(m),
  };
  const doc = readDocx(data, ctx);
  return { ...doc, stored, warnings: [...warnings] };
}

const text = (node: JSONContent): string => node.text ?? (node.content ?? []).map(text).join('');
const types = (blocks: JSONContent[]) => blocks.map((b) => b.type);

describe('XML', () => {
  it('reads elements, attributes, entities, CDATA and self-closing tags', () => {
    const root = parseXml(
      `<?xml version="1.0"?><!-- note --><a x="1" y='two &amp; &#x41;'><b/>Tom &lt;&amp;&gt; Jerry<![CDATA[<raw>]]><w:c w:val="v">&#233;</w:c></a>`,
    );
    const [a] = childElements(root);
    expect(a!.attrs).toEqual({ x: '1', y: 'two & A' });
    expect(childElements(a!).map((e) => e.name)).toEqual(['b', 'w:c']);
    expect(textContent(a!)).toBe('Tom <&> Jerry<raw>é');
    expect(childElements(a!, 'w:c')[0]!.attrs['w:val']).toBe('v');
  });

  it('is lenient: a stray close tag is ignored, unclosed elements end with the document', () => {
    const root = parseXml('<a><b>one</c></b><d>two');
    expect(textContent(root)).toBe('onetwo');
  });
});

describe('Word documents', () => {
  it('headings by style or outline level, a title, quotes, code and paragraphs', () => {
    const doc = read(
      docx(
        [
          styled('Title', 'Gripper design'),
          styled('Heading1', 'Overview'),
          styled('berschrift2', 'Ziele'),
          styled('Heading4', 'Deep'),
          p('', ''),
          p('Plain text.'),
          styled('Quote', 'Measure twice.'),
          styled('SourceCode', 'def grip():'),
          styled('SourceCode', '    pass'),
          p('Outline level', '<w:outlineLvl w:val="0"/>'),
        ].join(''),
        { 'word/styles.xml': STYLES },
      ),
    );
    expect(doc.title).toBe('Gripper design');
    expect(doc.blocks).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Overview' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Ziele' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Deep' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Plain text.' }] },
      {
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Measure twice.' }] }],
      },
      { type: 'codeBlock', content: [{ type: 'text', text: 'def grip():\n    pass' }] },
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Outline level' }] },
    ]);
  });

  it('the title from the document’s properties when there’s no Title paragraph', () => {
    const doc = read(
      docx(p('Body'), {
        'docProps/core.xml': `<cp:coreProperties xmlns:cp="cp" xmlns:dc="dc"><dc:title>Spec sheet</dc:title></cp:coreProperties>`,
      }),
    );
    expect(doc.title).toBe('Spec sheet');
    expect(read(docx(p('Body'))).title).toBeNull();
  });

  it('bullet and numbered lists, nested by level; checklists as to-dos', () => {
    const doc = read(
      docx(
        [
          listed(1, 0, 'Arms'),
          listed(1, 1, 'Shoulder'),
          listed(1, 1, 'Elbow'),
          listed(1, 0, 'Grippers'),
          p('Between'),
          listed(2, 0, 'First'),
          listed(2, 0, 'Second'),
          listed(1, 0, '☐ Order servos'),
          listed(1, 0, '☑ Print the mount'),
        ].join(''),
        { 'word/numbering.xml': NUMBERING },
      ),
    );
    expect(types(doc.blocks)).toEqual(['bulletList', 'paragraph', 'orderedList', 'taskList']);
    const [bullets, , numbered, tasks] = doc.blocks;
    expect(bullets!.content!.map(text)).toEqual(['ArmsShoulderElbow', 'Grippers']);
    const nested = bullets!.content![0]!.content![1]!;
    expect(nested.type).toBe('orderedList');
    expect(nested.content!.map(text)).toEqual(['Shoulder', 'Elbow']);
    expect(numbered!.content!.map(text)).toEqual(['First', 'Second']);
    expect(tasks!.content).toEqual([
      {
        type: 'taskItem',
        attrs: { checked: false },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Order servos' }] }],
      },
      {
        type: 'taskItem',
        attrs: { checked: true },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Print the mount' }] }],
      },
    ]);
  });

  it('bold, italic, underline, strikethrough, code, colours, links and line breaks', () => {
    const run = (t: string, props: string) =>
      `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
    const doc = read(
      docx(
        `<w:p>${[
          run('bold ', '<w:b/>'),
          run('not bold ', '<w:b w:val="0"/>'),
          run('italic ', '<w:i/>'),
          run('under ', '<w:u w:val="single"/>'),
          run('gone ', '<w:dstrike/>'),
          run('code', '<w:rFonts w:ascii="Courier New"/>'),
          run(' verbatim', '<w:rStyle w:val="VerbatimChar"/>'),
          run(' red', '<w:color w:val="C00000"/>'),
          run(' marked', '<w:highlight w:val="yellow"/>'),
          run(' black', '<w:color w:val="000000"/>'),
        ].join(
          '',
        )}<w:r><w:br/></w:r><w:hyperlink r:id="rLink"><w:r><w:t>site</w:t></w:r></w:hyperlink><w:hyperlink w:anchor="inside"><w:r><w:t> here</w:t></w:r></w:hyperlink></w:p>`,
        {
          'word/styles.xml': STYLES,
          'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rLink" Type="hyperlink" Target="https://example.com/a" TargetMode="External"/></Relationships>`,
        },
      ),
    );
    expect(doc.blocks[0]!.content).toEqual([
      { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'not bold ' },
      { type: 'text', text: 'italic ', marks: [{ type: 'italic' }] },
      { type: 'text', text: 'under ', marks: [{ type: 'underline' }] },
      { type: 'text', text: 'gone ', marks: [{ type: 'strike' }] },
      // (Neighbouring runs with the same marks are one text.)
      { type: 'text', text: 'code verbatim', marks: [{ type: 'code' }] },
      { type: 'text', text: ' red', marks: [{ type: 'color', attrs: { color: 'red' } }] },
      {
        type: 'text',
        text: ' marked',
        marks: [{ type: 'color', attrs: { color: 'yellow_background' } }],
      },
      { type: 'text', text: ' black' },
      { type: 'hardBreak' },
      {
        type: 'text',
        text: 'site',
        marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }],
      },
      { type: 'text', text: ' here' },
    ]);
  });

  it('pictures are stored and follow their paragraph; metafiles are left out', () => {
    const drawing = (id: string, alt: string) =>
      `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture" descr="${alt}"/><a:graphic><a:graphicData><pic:pic xmlns:pic="pic"><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const doc = read(
      docx(
        `<w:p><w:r><w:t>Before</w:t></w:r>${drawing('rImg', 'The arm')}</w:p><w:p>${drawing('rEmf', '')}</w:p>`,
        {
          'word/_rels/document.xml.rels': `<Relationships>
            <Relationship Id="rImg" Type="image" Target="media/image1.png"/>
            <Relationship Id="rEmf" Type="image" Target="media/image2.emf"/>
          </Relationships>`,
          'word/media/image1.png': PNG,
          'word/media/image2.emf': new Uint8Array([1, 2, 3]),
        },
      ),
    );
    expect(doc.blocks).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
      {
        type: 'image',
        attrs: { fileId: 'file-image1.png', name: 'image1.png', caption: 'The arm' },
      },
    ]);
    expect(doc.stored).toEqual([{ name: 'image1.png', mime: 'image/png' }]);
    expect(doc.warnings).toContain(
      'Pictures in Windows metafile format (EMF, WMF) weren’t imported',
    );
  });

  it('tables: a header row, merged cells, lists in cells as paragraphs', () => {
    const cell = (content: string, props = '') =>
      `<w:tc><w:tcPr>${props}</w:tcPr>${content}</w:tc>`;
    const doc = read(
      docx(
        `<w:tbl>
          <w:tr><w:trPr><w:tblHeader/></w:trPr>${cell(p('Joint'))}${cell(p('Range'))}</w:tr>
          <w:tr>${cell(p('Shoulder'), '<w:vMerge w:val="restart"/>')}${cell(listed(1, 0, '±170°'))}</w:tr>
          <w:tr>${cell(p(''), '<w:vMerge/>')}${cell(p('±90°'))}</w:tr>
          <w:tr>${cell(p('Total'), '<w:gridSpan w:val="2"/>')}</w:tr>
        </w:tbl>`,
        { 'word/numbering.xml': NUMBERING },
      ),
    );
    const [table] = doc.blocks;
    expect(table!.type).toBe('table');
    const rows = table!.content!;
    expect(rows[0]!.content!.map((c) => [c.type, text(c)])).toEqual([
      ['tableHeader', 'Joint'],
      ['tableHeader', 'Range'],
    ]);
    expect(rows[1]!.content!.map(text)).toEqual(['Shoulder', '• ±170°']);
    expect(rows[2]!.content!.map(text)).toEqual(['', '±90°']);
    expect(rows[3]!.content![0]).toMatchObject({ type: 'tableCell', attrs: { colspan: 2 } });
  });

  it('footnotes: numbered where they’re referenced, and listed at the end', () => {
    const doc = read(
      docx(`<w:p><w:r><w:t>Torque</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>`, {
        'word/footnotes.xml': `<w:footnotes ${W}>
            <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
            <w:footnote w:id="2"><w:p><w:r><w:t>At 12 V.</w:t></w:r></w:p></w:footnote>
          </w:footnotes>`,
      }),
    );
    expect(doc.blocks.map(text)).toEqual(['Torque[1]', 'Footnotes', 'At 12 V.']);
    expect(types(doc.blocks)).toEqual(['paragraph', 'heading', 'orderedList']);
  });

  it('says what it left out: equations, comments, tracked changes, text boxes', () => {
    const doc = read(
      docx(
        `<w:p><w:r><w:t>E = </w:t></w:r><m:oMath xmlns:m="m"><m:r><m:t>mc²</m:t></m:r></m:oMath><w:del><w:r><w:delText>old</w:delText></w:r></w:del><w:ins><w:r><w:t> new</w:t></w:r></w:ins></w:p>
         <w:p><w:r><w:pict><v:shape xmlns:v="v"><v:textbox><w:txbxContent><w:p><w:r><w:t>Boxed</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`,
        {
          'word/comments.xml': `<w:comments ${W}><w:comment w:id="0"><w:p><w:r><w:t>Check</w:t></w:r></w:p></w:comment></w:comments>`,
        },
      ),
    );
    expect(doc.blocks.map(text)).toEqual(['E = mc² new', 'Boxed']);
    expect(doc.warnings.sort()).toEqual([
      'Comments in Word documents weren’t imported',
      'Equations came over as plain text',
      'Text boxes came over as plain paragraphs',
      'Tracked changes: the current text was kept',
    ]);
  });

  it('maps colours to the nearest of the palette, leaving black, white and greys', () => {
    expect(nearestColor('C00000')).toBe('red');
    expect(nearestColor('0070C0')).toBe('blue');
    expect(nearestColor('00B050')).toBe('green');
    expect(nearestColor('7030A0')).toBe('purple');
    expect(nearestColor('000000')).toBeNull();
    expect(nearestColor('FFFFFF')).toBeNull();
    expect(nearestColor('808080')).toBe('gray');
    expect(nearestColor('auto')).toBeNull();
  });
});

describe('importing Word documents', () => {
  function target() {
    const workspace = new Y.Doc();
    const docs = new Map<string, Y.Doc>();
    const t: ImportTarget = {
      workspace,
      doc: (id) => {
        if (!docs.has(id)) docs.set(id, new Y.Doc());
        return docs.get(id)!;
      },
      storeFile: (_bytes, name) => `file-${name}`,
    };
    return { t, docs, workspace };
  }

  it('one document is the import’s page; several are pages under it', () => {
    const one = target();
    const report = importFiles(
      [
        {
          path: 'Spec.docx',
          data: docx(styled('Title', 'Gripper spec') + p('Body'), { 'word/styles.xml': STYLES }),
        },
      ],
      one.t,
      { title: 'Spec' },
    );
    expect(report).toMatchObject({ pages: 1, files: 0, warnings: [] });
    expect(getPage(one.workspace, report.rootId)!.title).toBe('Gripper spec');
    expect(readBlocks(one.docs.get(report.rootId)!).map((b) => b.text)).toEqual(['Body']);

    const two = target();
    const both = importFiles(
      [
        { path: 'a/Notes.docx', data: docx(p('First')) },
        { path: 'Broken.docx', data: strToU8('not a zip') },
        { path: 'Plan.docx', data: docx(p('Second')) },
      ],
      two.t,
      { title: 'Import' },
    );
    expect(both.pages).toBe(2);
    expect(
      listPages(two.workspace)
        .map((pg) => pg.title)
        .sort(),
    ).toEqual(['Import', 'Notes', 'Plan']);
    expect(both.warnings).toEqual(['“Broken” couldn’t be read as a Word document']);
  });

  it('refuses a document that unpacks to more than the limit', () => {
    // The guard reads each part's size from the zip's directory before inflating anything, so
    // a small zip that declares a big part stands in for a real one (compressing 200 MB would
    // take seconds).
    const zip = zipSync({ 'word/document.xml': strToU8('<w:document/>') }, { level: 0 });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = 0; i + 4 <= zip.length; i++) {
      const signature = view.getUint32(i, true);
      // The uncompressed size in the local header and in the central directory.
      if (signature === 0x04034b50) view.setUint32(i + 22, MAX_DOCX_BYTES + 1, true);
      if (signature === 0x02014b50) view.setUint32(i + 24, MAX_DOCX_BYTES + 1, true);
    }
    const t = target();
    const report = importFiles([{ path: 'Huge.docx', data: zip }], t.t, { title: 'Huge' });
    expect(report.warnings).toEqual(['“Huge” is too large to import']);
  });
});

describe('real Word files (pandoc and LibreOffice)', () => {
  for (const name of ['pandoc', 'libreoffice']) {
    it(`${name}: the title, headings, marks, a link, nested lists, a quote, a table, a picture, code and a footnote`, () => {
      const data = new Uint8Array(
        readFileSync(join(__dirname, '..', 'fixtures', 'docx', `${name}.docx`)),
      );
      const doc = read(data);
      expect(doc.title).toBe('Gripper design review');
      expect(doc.warnings).toEqual([]);
      expect(types(doc.blocks)).toEqual([
        'heading',
        'paragraph',
        'heading',
        'bulletList',
        'blockquote',
        'heading',
        'table',
        'image',
        'codeBlock',
        'paragraph',
        'heading',
        'orderedList',
      ]);
      const [overview, intro] = doc.blocks;
      expect(overview).toMatchObject({ attrs: { level: 1 } });
      expect(intro!.content).toEqual(
        expect.arrayContaining([
          { type: 'text', text: 'moving conveyor', marks: [{ type: 'bold' }] },
          { type: 'text', text: '60 cm', marks: [{ type: 'italic' }] },
          expect.objectContaining({
            text: 'calibration notes',
            marks: expect.arrayContaining([
              { type: 'link', attrs: { href: 'https://example.com/calibration' } },
            ]),
          }),
        ]),
      );
      const list = doc.blocks[3]!;
      expect(list.content!.map(text)).toEqual([
        'Pick 30 parts a minuteDetect the partPlan the grasp',
        'Keep the payload under 2 kg',
      ]);
      expect(list.content![0]!.content![1]!.type).toBe('orderedList');
      expect(text(doc.blocks[4]!)).toBe('Measure twice, cut once.');
      const table = doc.blocks[6]!;
      expect(table.content!.map((row) => row.content!.map(text))).toEqual([
        ['Joint', 'Range', 'Max speed'],
        ['Shoulder', '±170°', '180°/s'],
        ['Elbow', '±135°', '225°/s'],
      ]);
      expect(table.content![0]!.content![0]!.type).toBe('tableHeader');
      expect(doc.blocks[7]!.attrs).toMatchObject({ caption: 'The arm, from above' });
      expect(doc.stored).toHaveLength(1);
      expect(doc.stored[0]!.mime).toBe('image/png');
      expect(text(doc.blocks[8]!)).toBe('def reach(l1, l2):\n    return l1 + l2');
      expect(text(doc.blocks[9]!)).toBe('Torque is checked at 12 V.[1]');
      expect(text(doc.blocks[11]!)).toBe('With the servos warm.');
    });
  }
});

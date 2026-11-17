import { describe, expect, it } from 'vitest';
import { docToRuns, runsToDoc, type RichRun } from './rich-text-input';

describe('formatted text runs', () => {
  it('round-trip through the editor document, line breaks included', () => {
    const runs: RichRun[] = [
      { text: 'Torque ' },
      { text: '2 Nm', bold: true, color: 'red' },
      { text: '\n' },
      { text: 'spec', italic: true, link: 'https://example.org' },
    ];
    const doc = runsToDoc(runs);
    expect(doc.content).toHaveLength(1);
    expect(doc.content![0]!.content!.map((n) => n.type)).toEqual([
      'text',
      'text',
      'hardBreak',
      'text',
    ]);
    expect(docToRuns(doc)).toEqual(runs);
    // An unknown colour is dropped.
    expect(docToRuns(runsToDoc([{ text: 'x', color: 'plaid' }]))).toEqual([{ text: 'x' }]);
    expect(runsToDoc([]).content).toEqual([{ type: 'paragraph' }]);
  });
});

import type { Editor } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';

/** A simple table's cell texts, and whether its first row is a header row. */
export function tableCells(node: PMNode): { cells: string[][]; header: boolean } {
  const cells: string[][] = [];
  let header = false;
  node.forEach((row, _offset, index) => {
    const texts: string[] = [];
    let allHeaders = row.childCount > 0;
    row.forEach((cell) => {
      texts.push(cell.textContent);
      if (cell.type.name !== 'tableHeader') allHeaders = false;
    });
    if (index === 0) header = allHeaders;
    cells.push(texts);
  });
  return { cells, header };
}

/** A simple table node from cell texts; the first row becomes a header row. */
export function tableNode(schema: Schema, cells: string[][]): PMNode {
  const width = Math.max(1, ...cells.map((r) => r.length));
  const paragraph = (text: string) =>
    schema.nodes.paragraph!.create(null, text ? schema.text(text) : undefined);
  const rows = (cells.length ? cells : [['']]).map((row, r) =>
    schema.nodes.tableRow!.create(
      null,
      Array.from({ length: width }, (_, c) =>
        schema.nodes[r === 0 ? 'tableHeader' : 'tableCell']!.create(null, paragraph(row[c] ?? '')),
      ),
    ),
  );
  return schema.nodes.table!.create(null, rows);
}

/** Replace the block at `pos` with another node. */
export function replaceBlock(editor: Editor, pos: number, node: PMNode, next: PMNode): void {
  editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + node.nodeSize, next));
}

import { TableKit } from '@tiptap/extension-table';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { cn } from '@workspace/ui';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ColorPanel } from '../color-menu';
import { COLOR_PICKED, type ColorValue } from './colors';

export const Table = TableKit.configure({
  table: { resizable: true, cellMinWidth: 80 },
});

/** DOM element of the table that contains the selection. */
function selectedTableElement(editor: Editor): HTMLElement | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === 'table') {
      const dom = editor.view.nodeDOM($from.before(depth));
      return dom instanceof HTMLElement ? dom : null;
    }
  }
  return null;
}

/** The first row of the selected table is a header row. */
function hasHeaderRow(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'table') return node.firstChild?.firstChild?.type.name === 'tableHeader';
  }
  return false;
}

/** A row or a column of a simple table, to colour as one. */
export type TablePart = 'row' | 'column';

/** The selection's cell: its position, and the position and node of its table. */
function cellAround(state: EditorState) {
  const { $from } = state.selection;
  let cell = -1;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (cell < 0 && (name === 'tableCell' || name === 'tableHeader')) cell = depth;
    if (name === 'table' && cell > 0) {
      return { cellPos: $from.before(cell), table: $from.node(depth), start: $from.start(depth) };
    }
  }
  return null;
}

/** Positions of the cells in the row or column of the selection's cell. */
export function tablePartCells(state: EditorState, part: TablePart): number[] {
  const around = cellAround(state);
  if (!around) return [];
  const map = TableMap.get(around.table);
  const cell = map.findCell(around.cellPos - around.start);
  const rect =
    part === 'row'
      ? { left: 0, right: map.width, top: cell.top, bottom: cell.bottom }
      : { left: cell.left, right: cell.right, top: 0, bottom: map.height };
  return map.cellsInRect(rect).map((pos) => pos + around.start);
}

/** The colour of the selection's cell. */
export function cellColor(state: EditorState): ColorValue | null {
  const around = cellAround(state);
  const color = around && state.doc.nodeAt(around.cellPos)?.attrs.color;
  return typeof color === 'string' ? (color as ColorValue) : null;
}

/** Colour the row or column of the selection's cell; `null` takes the colour off. */
export function colorTablePart(
  part: TablePart,
  value: ColorValue | null,
): (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean {
  return (state, dispatch) => {
    const cells = tablePartCells(state, part);
    if (!cells.length) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const pos of cells) {
        const node = tr.doc.nodeAt(pos);
        if (node) tr.setNodeMarkup(pos, undefined, { ...node.attrs, color: value });
      }
      if (value) tr.setMeta(COLOR_PICKED, value);
      dispatch(tr);
    }
    return true;
  };
}

function TableButton(props: {
  label: string;
  active?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      className={cn(
        'h-7 rounded px-2 text-xs whitespace-nowrap hover:bg-hover',
        props.active ? 'text-accent' : 'text-fg',
      )}
    >
      {props.children}
    </button>
  );
}

/** Toolbar above a table while the cursor is in it. */
export function TableMenu({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({ headerRow: hasHeaderRow(e), color: cellColor(e.state) }),
  });
  // The part whose colour is being picked.
  const [coloring, setColoring] = useState<TablePart | null>(null);

  const getReferencedVirtualElement = useCallback(() => {
    const el = selectedTableElement(editor);
    return el ? { getBoundingClientRect: () => el.getBoundingClientRect() } : null;
  }, [editor]);
  const options = useMemo(() => ({ placement: 'top-start' as const, offset: 6 }), []);

  const run = (fn: (e: Editor) => boolean) => () => fn(editor);

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      shouldShow={showInTable}
      getReferencedVirtualElement={getReferencedVirtualElement}
      options={options}
      className="ws-floating"
      data-testid="table-menu"
    >
      <div className="rounded-lg bg-menu shadow-menu">
        <div className="flex items-center gap-0.5 p-1">
          <TableButton
            label="Add row below"
            onClick={run((e) => e.chain().focus().addRowAfter().run())}
          >
            + Row
          </TableButton>
          <TableButton
            label="Add column right"
            onClick={run((e) => e.chain().focus().addColumnAfter().run())}
          >
            + Column
          </TableButton>
          <TableButton label="Delete row" onClick={run((e) => e.chain().focus().deleteRow().run())}>
            − Row
          </TableButton>
          <TableButton
            label="Delete column"
            onClick={run((e) => e.chain().focus().deleteColumn().run())}
          >
            − Column
          </TableButton>
          <span className="mx-0.5 h-5 w-px bg-line" />
          <TableButton
            label="Header row"
            active={state.headerRow}
            onClick={run((e) => e.chain().focus().toggleHeaderRow().run())}
          >
            Header row
          </TableButton>
          <TableButton
            label="Header column"
            onClick={run((e) => e.chain().focus().toggleHeaderColumn().run())}
          >
            Header column
          </TableButton>
          <span className="mx-0.5 h-5 w-px bg-line" />
          <TableButton
            label="Row color"
            active={coloring === 'row'}
            onClick={() => setColoring(coloring === 'row' ? null : 'row')}
          >
            Row color
          </TableButton>
          <TableButton
            label="Column color"
            active={coloring === 'column'}
            onClick={() => setColoring(coloring === 'column' ? null : 'column')}
          >
            Column color
          </TableButton>
          <span className="mx-0.5 h-5 w-px bg-line" />
          <TableButton
            label="Delete table"
            onClick={run((e) => e.chain().focus().deleteTable().run())}
          >
            Delete
          </TableButton>
        </div>
        {coloring && (
          <ColorPanel
            current={state.color}
            onPick={(value) => {
              colorTablePart(coloring, value)(editor.state, editor.view.dispatch);
              setColoring(null);
            }}
          />
        )}
      </div>
    </BubbleMenu>
  );
}

type ShouldShow = NonNullable<React.ComponentProps<typeof BubbleMenu>['shouldShow']>;

const showInTable: ShouldShow = ({ editor, state }) =>
  editor.isEditable && state.selection.empty && editor.isActive('table');

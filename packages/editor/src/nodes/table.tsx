import { TableKit } from '@tiptap/extension-table';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { cn } from '@workspace/ui';
import { useCallback, useMemo, type ReactNode } from 'react';

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
    selector: ({ editor: e }) => ({ headerRow: hasHeaderRow(e) }),
  });

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
      <div className="flex items-center gap-0.5 rounded-lg bg-menu p-1 shadow-menu">
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
          label="Delete table"
          onClick={run((e) => e.chain().focus().deleteTable().run())}
        >
          Delete
        </TableButton>
      </div>
    </BubbleMenu>
  );
}

type ShouldShow = NonNullable<React.ComponentProps<typeof BubbleMenu>['shouldShow']>;

const showInTable: ShouldShow = ({ editor, state }) =>
  editor.isEditable && state.selection.empty && editor.isActive('table');

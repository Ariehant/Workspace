import { Node, mergeAttributes } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      /** Replace the current empty block (or insert after it) with `count` columns. */
      insertColumns: (count: number) => ReturnType;
    };
  }
}

/** Fraction of a block's width, at each side, that counts as "drop beside it". */
const EDGE = 0.15;
const MIN_COLUMN_PX = 64;

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  defining: true,

  addAttributes() {
    return {
      // Relative width (flex-grow); `null` means equal widths.
      width: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute('data-width')) || null,
        renderHTML: (attrs) =>
          attrs.width
            ? { 'data-width': attrs.width, style: `flex-grow: ${attrs.width as number}` }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'ws-column' }),
      0,
    ];
  },
});

export const ColumnList = Node.create({
  name: 'columnList',
  group: 'block',
  // `column+` rather than `column{2,}` so edits can pass through a one-column state;
  // the normalizer below unwraps it.
  content: 'column+',
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-type="column-list"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'column-list', class: 'ws-columns' }),
      0,
    ];
  },

  addCommands() {
    return {
      insertColumns:
        (count) =>
        ({ state, tr, dispatch }) => {
          const { schema } = state;
          const { $from } = state.selection;
          if ($from.depth < 1) return false;
          const start = $from.before($from.depth);
          const end = $from.after($from.depth);
          const replace = $from.parent.isTextblock && $from.parent.content.size === 0;
          const columns = Array.from({ length: count }, () =>
            schema.nodes.column!.create(null, schema.nodes.paragraph!.create()),
          );
          const list = schema.nodes.columnList!.create(null, columns);
          if (!dispatch) return true;
          if (replace) tr.replaceWith(start, end, list);
          else tr.insert(end, list);
          const at = replace ? start : end;
          tr.setSelection(TextSelection.near(tr.doc.resolve(at + 3)));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [dropIntoColumns(), normalizeColumns(), resizeColumns()];
  },
});

// --- Drop beside a block to make columns -------------------------------------------

interface DropTarget {
  /** Position of the block (or column) the pointer is over. */
  pos: number;
  node: PMNode;
  side: 'left' | 'right';
  /** Set when the target is a column inside an existing column list. */
  inColumns: boolean;
}

function findDropTarget(view: EditorView, event: DragEvent): DropTarget | null {
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return null;
  const $pos = view.state.doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos);
  if ($pos.depth < 1 && hit.inside < 0) return null;

  const topPos = $pos.depth >= 1 ? $pos.before(1) : hit.inside;
  const top = view.state.doc.nodeAt(topPos);
  if (!top) return null;

  let pos = topPos;
  let node = top;
  let inColumns = false;
  if (top.type.name === 'columnList') {
    if ($pos.depth < 2) return null;
    pos = $pos.before(2);
    node = view.state.doc.nodeAt(pos)!;
    inColumns = true;
  }

  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  const zone = rect.width * EDGE;
  // Only drops *inside* the block's edges make columns. While reordering, the pointer
  // sits left of the block (where the drag handle is) and must not trigger this.
  const x = event.clientX;
  if (x < rect.left || x > rect.right) return null;
  const side = x < rect.left + zone ? 'left' : x > rect.right - zone ? 'right' : null;
  return side ? { pos, node, side, inColumns } : null;
}

function dropIntoColumns() {
  return new Plugin({
    key: new PluginKey('dropIntoColumns'),
    props: {
      handleDrop(view, event, slice, moved) {
        if (!moved || slice.openStart > 0 || slice.openEnd > 0) return false;
        const target = findDropTarget(view, event as DragEvent);
        if (!target) return false;

        const { state } = view;
        const source = state.selection;
        const targetEnd = target.pos + target.node.nodeSize;
        // Dropping a block beside itself, or into itself, does nothing.
        if (source.from < targetEnd && source.to > target.pos) return false;

        const schema = state.schema;
        const column = schema.nodes.column!.createAndFill(null, slice.content);
        if (!column) return false;

        const tr = state.tr;
        if (target.inColumns) {
          tr.insert(target.side === 'left' ? target.pos : targetEnd, column);
        } else {
          const existing = schema.nodes.column!.create(null, target.node);
          const list = schema.nodes.columnList!.create(
            null,
            target.side === 'left' ? [column, existing] : [existing, column],
          );
          tr.replaceWith(target.pos, targetEnd, list);
        }
        tr.delete(tr.mapping.map(source.from), tr.mapping.map(source.to));
        resetWidthsAround(tr, tr.mapping.map(target.pos));
        tr.setMeta('uiEvent', 'drop');
        view.dispatch(tr.scrollIntoView());
        event.preventDefault();
        return true;
      },
    },
  });
}

/** After adding a column, make all columns in that list equal width again. */
function resetWidthsAround(tr: Transaction, pos: number) {
  const $pos = tr.doc.resolve(Math.min(pos, tr.doc.content.size));
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = depth === 0 ? tr.doc.nodeAt($pos.pos) : $pos.node(depth);
    const listPos = depth === 0 ? $pos.pos : $pos.before(depth);
    if (node?.type.name !== 'columnList') continue;
    node.forEach((col, offset) => {
      if (col.attrs.width)
        tr.setNodeMarkup(listPos + 1 + offset, undefined, { ...col.attrs, width: null });
    });
    return;
  }
}

// --- Keep column lists well-formed ------------------------------------------------

const isEmptyColumn = (column: PMNode) =>
  column.childCount === 1 &&
  column.firstChild!.isTextblock &&
  column.firstChild!.content.size === 0;

/**
 * Fix up column lists after edits:
 * - after a drag-and-drop, drop columns left holding only an empty block;
 * - a list with a single column is replaced by that column's blocks.
 */
export function normalizeColumnsIn(
  doc: PMNode,
  tr: Transaction,
  schema: Schema,
  afterDrop: boolean,
) {
  const lists: { pos: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.columnList) lists.push({ pos, node });
    // Column lists don't nest, and nothing below a textblock can hold one.
    return node.type !== schema.nodes.columnList && !node.isTextblock;
  });

  // Work from the end so earlier positions stay valid.
  for (const { pos, node } of lists.reverse()) {
    let columns: PMNode[] = [];
    node.forEach((col) => columns.push(col));
    if (afterDrop && columns.some((c) => !isEmptyColumn(c))) {
      columns = columns.filter((c) => !isEmptyColumn(c));
    }
    if (columns.length === node.childCount && columns.length > 1) continue;
    if (columns.length <= 1) {
      const content = columns[0]?.content ?? schema.nodes.paragraph!.create();
      tr.replaceWith(pos, pos + node.nodeSize, content);
    } else {
      tr.replaceWith(pos, pos + node.nodeSize, node.type.create(node.attrs, columns));
    }
  }
}

function normalizeColumns() {
  return new Plugin({
    key: new PluginKey('normalizeColumns'),
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((t) => t.docChanged)) return null;
      const afterDrop = transactions.some((t) => t.getMeta('uiEvent') === 'drop');
      const tr = state.tr;
      normalizeColumnsIn(state.doc, tr, state.schema, afterDrop);
      return tr.docChanged ? tr : null;
    },
  });
}

// --- Drag the gap between columns to resize them -----------------------------------

function resizeColumns() {
  return new Plugin({
    key: new PluginKey('resizeColumns'),
    props: {
      handleDOMEvents: {
        // The gap after each column (its ::after hit area) belongs to the column
        // element, so a press right of the column's box starts a resize.
        mousedown(view, event) {
          const left = event.target as HTMLElement;
          if (!view.editable || !left.classList?.contains('ws-column')) return false;
          const right = left.nextElementSibling as HTMLElement | null;
          const leftRect = left.getBoundingClientRect();
          if (!right || event.clientX <= leftRect.right) return false;
          event.preventDefault();

          const rightRect = right.getBoundingClientRect();
          const grow = (el: HTMLElement) => Number(getComputedStyle(el).flexGrow) || 1;
          const totalGrow = grow(left) + grow(right);
          const totalPx = leftRect.width + rightRect.width;
          const startX = event.clientX;
          let leftGrow = grow(left);

          const onMove = (move: MouseEvent) => {
            const leftPx = Math.min(
              Math.max(leftRect.width + move.clientX - startX, MIN_COLUMN_PX),
              totalPx - MIN_COLUMN_PX,
            );
            leftGrow = (totalGrow * leftPx) / totalPx;
            left.style.flexGrow = String(leftGrow);
            right.style.flexGrow = String(totalGrow - leftGrow);
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const leftPos = view.posAtDOM(left, 0) - 1;
            const rightPos = view.posAtDOM(right, 0) - 1;
            const tr = view.state.tr;
            for (const [pos, width] of [
              [leftPos, leftGrow],
              [rightPos, totalGrow - leftGrow],
            ] as const) {
              const node = tr.doc.nodeAt(pos);
              if (node?.type.name === 'column') {
                tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  width: Number(width.toFixed(4)),
                });
              }
            }
            view.dispatch(tr);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
          return true;
        },
      },
    },
  });
}

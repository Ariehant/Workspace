import type { Row } from '@workspace/database';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Card, PREVIEW_HEIGHT, shownProperties, type LayoutViewProps } from './cards';
import { Lines, buildLines, useLayoutGroups } from './list';

const MIN_CARD = { small: 180, medium: 240, large: 320 } as const;
const GAP = 16;

/** Gallery: a responsive grid of cards (rows of cards are virtualized for long views). */
export function GalleryView(props: LayoutViewProps) {
  const { handle, snapshot, view, result, ctx, editable, onOpenRow } = props;
  const properties = shownProperties(view, snapshot);
  const groups = useLayoutGroups(props);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const perRow = Math.max(1, Math.floor((width + GAP) / (MIN_CARD[view.cardSize] + GAP)));

  // Each group's cards, split into rows of the grid.
  const lines = buildLines<Row[]>(result, (rows, path) => {
    const chunks: { key: string; item: Row[] }[] = [];
    for (let i = 0; i < rows.length; i += perRow) {
      chunks.push({ key: `${path}#${i / perRow}`, item: rows.slice(i, i + perRow) });
    }
    return chunks;
  });
  const cardHeight =
    (view.cardPreview.kind === 'none' ? 0 : PREVIEW_HEIGHT[view.cardSize]) +
    40 +
    properties.length * 22;

  return (
    <div ref={ref} data-testid="gallery-view" className="pt-3 pb-4 text-sm">
      <Lines
        lines={lines}
        estimate={(line) =>
          line.kind === 'header' ? 41 : line.kind === 'new' ? 44 : cardHeight + GAP
        }
        render={(line) => {
          if (line.kind === 'header') return groups.header(line);
          if (line.kind === 'new') {
            return editable && groups.canAdd(line.infos) ? (
              <button
                type="button"
                data-testid="gallery-new"
                onClick={() => groups.add(line.infos)}
                className="mb-4 flex h-10 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line text-muted hover:bg-hover"
              >
                <Plus size={14} /> New
              </button>
            ) : null;
          }
          return (
            <div
              className="grid pb-4"
              style={{ gap: GAP, gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}
            >
              {line.item.map((slot) => (
                <Card
                  key={slot.id}
                  handle={handle}
                  snapshot={snapshot}
                  view={view}
                  row={slot}
                  properties={properties}
                  ctx={ctx}
                  layout="gallery"
                  editingTitle={groups.editingTitle === slot.id}
                  onTitleDone={() => groups.setEditingTitle(null)}
                  onOpen={() => onOpenRow(slot.id)}
                  draggable={false}
                />
              ))}
            </div>
          );
        }}
      />
    </div>
  );
}

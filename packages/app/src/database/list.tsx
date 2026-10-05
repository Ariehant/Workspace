import {
  isCellEmpty,
  type GroupInfo,
  type Row,
  type View,
  type ViewGroup,
  type ViewResult,
} from '@workspace/database';
import { PageIcon } from '@workspace/editor';
import { cn } from '@workspace/ui';
import { Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useApp } from '../context';
import { newRow } from './actions';
import { CellDisplay, TextCellEditor } from './cells';
import {
  SectionHeader,
  groupValues,
  shownProperties,
  titleProperty,
  toggleGroupKey,
  type LayoutViewProps,
} from './cards';
import { usePageVirtualizer } from './virtual';

/** A line of a list or gallery: a group header, content, or "+ New" for a group. */
export type Line<T> =
  | { kind: 'header'; key: string; depth: number; group: ViewGroup; infos: GroupInfo[] }
  | { kind: 'item'; key: string; depth: number; item: T }
  | { kind: 'new'; key: string; depth: number; infos: GroupInfo[] };

/**
 * Flatten a view result into lines: group headers (hidden groups left out, collapsed
 * ones without their content), then `chunk(rows)` items and a "+ New" line per group.
 */
export function buildLines<T>(
  result: ViewResult,
  chunk: (rows: Row[], path: string) => { key: string; item: T }[],
): Line<T>[] {
  if (!result.groups) {
    return [
      ...chunk(result.rows, '/').map((c) => ({ kind: 'item' as const, depth: 0, ...c })),
      { kind: 'new', key: 'new:/', depth: 0, infos: [] },
    ];
  }
  const lines: Line<T>[] = [];
  const add = (groups: ViewGroup[], depth: number, parents: GroupInfo[], path: string) => {
    for (const group of groups) {
      if (group.hidden) continue;
      const key = `${path}${group.info.key}/`;
      const infos = [...parents, group.info];
      lines.push({ kind: 'header', key: `group:${key}`, depth, group, infos });
      if (group.collapsed) continue;
      if (group.subgroups) {
        add(group.subgroups, depth + 1, infos, key);
        continue;
      }
      for (const c of chunk(group.rows, key)) lines.push({ kind: 'item', depth, ...c });
      lines.push({ kind: 'new', key: `new:${key}`, depth, infos });
    }
  };
  add(result.groups, 0, [], '/');
  return lines;
}

/** Renders lines, virtualized for long views. */
export function Lines<T>({
  lines,
  estimate,
  render,
  className,
}: {
  lines: Line<T>[];
  estimate(line: Line<T>): number;
  render(line: Line<T>): ReactNode;
  className?: string;
}) {
  const virtual = lines.length >= 100;
  const { bodyRef, virtualizer } = usePageVirtualizer({
    count: lines.length,
    enabled: virtual,
    estimateSize: (i) => estimate(lines[i]!),
    getItemKey: (i) => lines[i]?.key ?? i,
  });
  if (!virtual) {
    return (
      <div ref={bodyRef} className={className}>
        {lines.map((line) => (
          <div key={line.key}>{render(line)}</div>
        ))}
      </div>
    );
  }
  return (
    <div
      ref={bodyRef}
      className={cn('relative', className)}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((v) => (
        <div
          key={v.key}
          data-index={v.index}
          ref={virtualizer.measureElement}
          className="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)` }}
        >
          {render(lines[v.index]!)}
        </div>
      ))}
    </div>
  );
}

/** Group header, collapse/hide and "+ New" handling shared by list and gallery. */
export function useLayoutGroups(props: LayoutViewProps) {
  const { handle, view, snapshot } = props;
  const { user, client } = useApp();
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const levels = [view.groupBy, view.subGroupBy];
  const property = (depth: number) =>
    snapshot.properties.find((p) => p.id === levels[depth]?.propertyId);
  const add = (infos: GroupInfo[]) => {
    const id = newRow(client, handle, snapshot, view, {
      actor: user.id,
      values: groupValues(view, infos),
    });
    setEditingTitle(id);
  };
  const canAdd = (view: View, infos: GroupInfo[]) =>
    infos.every((i) => i.value !== undefined) && !!view;
  const header = (line: Extract<Line<unknown>, { kind: 'header' }>) => (
    <SectionHeader
      group={line.group}
      property={property(line.depth)}
      depth={line.depth}
      editable={props.editable}
      onToggle={() => toggleGroupKey(handle, view, line.depth, line.group.info.key, 'collapsed')}
      onHide={() => toggleGroupKey(handle, view, line.depth, line.group.info.key, 'hidden')}
      onAdd={canAdd(view, line.infos) && !line.group.subgroups ? () => add(line.infos) : undefined}
    />
  );
  return {
    editingTitle,
    setEditingTitle,
    add,
    canAdd: (infos: GroupInfo[]) => canAdd(view, infos),
    header,
  };
}

/** List: one compact line per row, its title and the properties picked for the view. */
export function ListView(props: LayoutViewProps) {
  const { handle, snapshot, view, result, ctx, editable, onOpenRow } = props;
  const { platform } = useApp();
  const properties = shownProperties(view, snapshot);
  const groups = useLayoutGroups(props);
  const lines = buildLines<Row>(result, (rows, path) =>
    rows.map((row) => ({ key: `${path}${row.id}`, item: row })),
  );
  return (
    <div data-testid="list-view" className="pt-1 pb-4 text-sm">
      <Lines
        lines={lines}
        estimate={(line) => (line.kind === 'header' ? 41 : 36)}
        render={(line) => {
          if (line.kind === 'header') return groups.header(line);
          if (line.kind === 'new') {
            return editable && groups.canAdd(line.infos) ? (
              <button
                type="button"
                data-testid="list-new"
                onClick={() => groups.add(line.infos)}
                className="flex h-9 w-full items-center gap-1.5 rounded px-2 text-muted hover:bg-hover"
              >
                <Plus size={14} /> New page
              </button>
            ) : null;
          }
          const row = line.item;
          const shown = properties.filter((p) => !isCellEmpty(row, p) || p.type === 'checkbox');
          return (
            <div
              role="button"
              tabIndex={0}
              data-testid="list-row"
              data-row-id={row.id}
              onClick={() => groups.editingTitle !== row.id && onOpenRow(row.id)}
              onKeyDown={(e) =>
                e.key === 'Enter' && e.target === e.currentTarget && onOpenRow(row.id)
              }
              className={cn(
                'flex min-h-9 items-center gap-3 rounded px-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent',
                line.depth > 0 && 'ml-5',
              )}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <PageIcon
                  icon={row.icon}
                  size={16}
                  fileUrl={platform.fileUrl}
                  className="shrink-0 text-muted"
                />
                {groups.editingTitle === row.id ? (
                  <TextCellEditor
                    handle={handle}
                    row={row}
                    property={titleProperty(snapshot)}
                    ctx={ctx}
                    onDone={() => groups.setEditingTitle(null)}
                    className="rounded border border-accent"
                  />
                ) : (
                  <span
                    data-testid="list-title"
                    className={cn('truncate font-medium', !row.title && 'text-faint')}
                  >
                    {row.title || 'Untitled'}
                  </span>
                )}
              </span>
              <span className="flex max-w-[60%] shrink-0 items-center gap-3 overflow-hidden text-[13px]">
                {shown.map((property) => (
                  <span
                    key={property.id}
                    data-testid="list-property"
                    title={property.name}
                    className="flex max-w-48 min-w-0 items-center"
                  >
                    <CellDisplay row={row} property={property} ctx={ctx} variant="panel" />
                  </span>
                ))}
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}

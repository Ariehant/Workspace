/**
 * Feed (Phase 8 N7, #18): a database's rows as a stream of whole pages, newest first by
 * default as the view sorts them. Each shows its title (which opens the row), the
 * properties picked for the view, and its content, read-only.
 *
 * Every item is a full editor, so only the items in view are rendered (and their pages
 * loaded), and a feed starts with a load limit.
 */
import { readBlocks } from '@workspace/core';
import { isCellEmpty, type Property, type Row } from '@workspace/database';
import { PageEditor, PageIcon } from '@workspace/editor';
import { cn } from '@workspace/ui';
import { Plus } from 'lucide-react';
import { useApp } from '../context';
import { useEditorServices } from '../editor-services';
import { useDoc, useDocVersion } from '../hooks';
import { CellDisplay, TextCellEditor } from './cells';
import { shownProperties, titleProperty, type LayoutViewProps } from './cards';
import { LoadMoreLine, Lines, buildLines, useLayoutGroups, useLoadMore } from './list';

/** A feed item's height before it's measured (its page decides the real one). */
const ITEM_ESTIMATE = 320;

/** A row's page, read-only; nothing when it's empty. */
function FeedContent({ rowId }: { rowId: string }) {
  const { client } = useApp();
  const doc = useDoc(client, rowId);
  useDocVersion(doc);
  const services = useEditorServices(rowId);
  if (!doc) return <div className="h-16" aria-busy="true" data-testid="feed-loading" />;
  const empty = readBlocks(doc).every(
    (b) => b.type === 'paragraph' && !b.text && b.children.length === 0,
  );
  if (empty) return null;
  return (
    <div className="ws-feed-content mt-2" data-testid="feed-content">
      <PageEditor doc={doc} services={services} editable={false} nested />
    </div>
  );
}

function FeedItem({
  row,
  properties,
  depth,
  props,
  editingTitle,
  onTitleDone,
}: {
  row: Row;
  properties: Property[];
  depth: number;
  props: LayoutViewProps;
  editingTitle: boolean;
  onTitleDone(): void;
}) {
  const { platform } = useApp();
  const { handle, snapshot, ctx, onOpenRow } = props;
  const shown = properties.filter((p) => !isCellEmpty(row, p) || p.type === 'checkbox');
  return (
    <article
      aria-label={row.title || 'Untitled'}
      data-testid="feed-item"
      data-row-id={row.id}
      className={cn('mb-4 rounded-lg border border-line px-5 py-4', depth > 0 && 'ml-5')}
    >
      <header className="flex items-center gap-2">
        <PageIcon icon={row.icon} size={20} fileUrl={platform.fileUrl} className="shrink-0" />
        {editingTitle ? (
          <TextCellEditor
            handle={handle}
            row={row}
            property={titleProperty(snapshot)}
            ctx={ctx}
            onDone={onTitleDone}
            className="flex-1 rounded border border-accent text-lg font-semibold"
          />
        ) : (
          // The title opens the row (the page below is for reading, and selecting text).
          <button
            type="button"
            data-testid="feed-title"
            onClick={() => onOpenRow(row.id)}
            className={cn(
              'min-w-0 truncate rounded text-left text-lg font-semibold hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
              !row.title && 'text-faint',
            )}
          >
            {row.title || 'Untitled'}
          </button>
        )}
      </header>
      {shown.length > 0 && (
        <dl className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
          {shown.map((property) => (
            <div
              key={property.id}
              className="flex min-w-0 items-center gap-1.5"
              data-testid="feed-property"
            >
              <dt className="text-muted">{property.name}</dt>
              <dd className="min-w-0">
                <CellDisplay row={row} property={property} ctx={ctx} variant="panel" />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <FeedContent rowId={row.id} />
    </article>
  );
}

export function FeedView(props: LayoutViewProps) {
  const { view, snapshot, result, editable } = props;
  const properties = shownProperties(view, snapshot);
  const groups = useLayoutGroups(props);
  const { loaded, more } = useLoadMore();
  const lines = buildLines<Row>(
    result,
    (rows, path) => rows.map((row) => ({ key: `${path}${row.id}`, item: row })),
    { limit: view.loadLimit, loaded },
  );
  return (
    <div data-testid="feed-view" className="mx-auto max-w-[760px] pt-3 pb-4 text-sm">
      <Lines
        lines={lines}
        virtualizeFrom={0}
        estimate={(line) =>
          line.kind === 'header' ? 41 : line.kind === 'item' ? ITEM_ESTIMATE : 44
        }
        render={(line) => {
          if (line.kind === 'header') return groups.header(line);
          if (line.kind === 'more') {
            return <LoadMoreLine line={line} limit={view.loadLimit ?? line.total} onMore={more} />;
          }
          if (line.kind === 'new') {
            return editable && groups.canAdd(line.infos) ? (
              <button
                type="button"
                data-testid="feed-new"
                onClick={() => groups.add(line.infos)}
                className="mb-4 flex h-10 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line text-muted hover:bg-hover"
              >
                <Plus size={14} /> New page
              </button>
            ) : null;
          }
          return (
            <FeedItem
              row={line.item}
              properties={properties}
              depth={line.depth}
              props={props}
              editingTitle={groups.editingTitle === line.item.id}
              onTitleDone={() => groups.setEditingTitle(null)}
            />
          );
        }}
      />
    </div>
  );
}

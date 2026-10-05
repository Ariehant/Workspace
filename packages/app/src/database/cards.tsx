import { firstImage } from '@workspace/core';
import {
  TITLE_PROPERTY_ID,
  NO_VALUE,
  cellValue,
  isCellEmpty,
  updateView,
  viewColumns,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type DisplayContext,
  type FileValue,
  type GroupInfo,
  type Property,
  type Row,
  type View,
  type ViewGroup,
  type ViewResult,
} from '@workspace/database';
import { PageIcon } from '@workspace/editor';
import { IconButton, cn } from '@workspace/ui';
import { ChevronRight, EyeOff, Plus } from 'lucide-react';
import { useMemo, type DragEvent, type ReactNode } from 'react';
import { useApp } from '../context';
import { useDoc, useDocVersion } from '../hooks';
import { coverStyle } from '../cover';
import { CellDisplay, OptionPill, TextCellEditor } from './cells';

/** Props shared by the board, list and gallery views. */
export interface LayoutViewProps {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  view: View;
  result: ViewResult;
  ctx: DisplayContext;
  editable: boolean;
  onOpenRow(rowId: string): void;
}

/** Properties shown on cards and list rows: the view's visible ones, title aside. */
export function shownProperties(view: View, snapshot: DatabaseSnapshot): Property[] {
  const byId = new Map(snapshot.properties.map((p) => [p.id, p]));
  return viewColumns(view, snapshot.properties)
    .filter((c) => c.visible && c.id !== TITLE_PROPERTY_ID)
    .map((c) => byId.get(c.id)!)
    .filter(Boolean);
}

export const titleProperty = (snapshot: DatabaseSnapshot) =>
  snapshot.properties.find((p) => p.id === TITLE_PROPERTY_ID)!;

/** Values a new row gets in a group (and sub-group), where they can be set. */
export function groupValues(
  view: View,
  infos: (GroupInfo | null | undefined)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const levels = [view.groupBy, view.subGroupBy];
  infos.forEach((info, depth) => {
    const level = levels[depth];
    if (info && level && info.value !== undefined && info.value !== null) {
      out[level.propertyId] = info.value;
    }
  });
  return out;
}

/** Hide/show or collapse/expand a group of a view (saved in the view). */
export function toggleGroupKey(
  handle: DatabaseHandle,
  view: View,
  depth: number,
  key: string,
  field: 'hidden' | 'collapsed',
): void {
  const levelKey = depth === 0 ? 'groupBy' : 'subGroupBy';
  const groupBy = view[levelKey];
  if (!groupBy) return;
  const list = groupBy[field] ?? [];
  updateView(handle.doc, view.id, {
    [levelKey]: {
      ...groupBy,
      [field]: list.includes(key) ? list.filter((k) => k !== key) : [...list, key],
    },
  });
}

/** A group's name: an option pill for select-like groups, else text. */
export function GroupLabel({ info, property }: { info: GroupInfo; property?: Property }) {
  const isOption =
    info.color !== undefined ||
    property?.type === 'select' ||
    property?.type === 'multiSelect' ||
    property?.type === 'status';
  return isOption && info.key !== NO_VALUE ? (
    <OptionPill
      option={{ id: info.key, name: info.label, color: info.color ?? 'default' }}
      status={info.status}
    />
  ) : (
    <span className="truncate font-medium">{info.label}</span>
  );
}

/** Group header for list and gallery views. */
export function SectionHeader({
  group,
  property,
  depth,
  editable,
  onToggle,
  onHide,
  onAdd,
}: {
  group: ViewGroup;
  property?: Property;
  depth: number;
  editable: boolean;
  onToggle(): void;
  onHide(): void;
  onAdd?: () => void;
}) {
  return (
    <div
      data-testid="group-header"
      data-group-key={group.info.key}
      className={cn('group/g flex h-[41px] items-center gap-1.5 text-sm', depth > 0 && 'pl-5')}
    >
      <IconButton
        label={group.collapsed ? 'Expand group' : 'Collapse group'}
        size="sm"
        onClick={onToggle}
      >
        <ChevronRight
          size={14}
          className={cn('transition-transform', !group.collapsed && 'rotate-90')}
        />
      </IconButton>
      <span className="flex min-w-0 items-center gap-2" data-testid="group-label">
        <GroupLabel info={group.info} property={property} />
        <span className="text-faint" data-testid="group-count">
          {group.rows.length}
        </span>
      </span>
      {editable && (
        <span className="flex items-center opacity-0 group-hover/g:opacity-100">
          <IconButton label="Hide group" size="sm" onClick={onHide}>
            <EyeOff size={13} />
          </IconButton>
          {onAdd && (
            <IconButton label="New in group" size="sm" onClick={onAdd}>
              <Plus size={14} />
            </IconButton>
          )}
        </span>
      )}
    </div>
  );
}

// --- Card previews -----------------------------------------------------------------------

/** URL of the first image in a row's page content (loads the page while shown). */
function useContentImage(rowId: string | null): string | null {
  const { client, platform } = useApp();
  const doc = useDoc(client, rowId);
  const version = useDocVersion(doc);
  return useMemo(() => {
    void version;
    const image = doc ? firstImage(doc) : null;
    if (!image) return null;
    return image.fileId ? platform.fileUrl(image.fileId) : (image.src ?? null);
  }, [doc, version, platform]);
}

function fileImage(row: Row, property: Property | undefined, fileUrl: (id: string) => string) {
  if (!property) return null;
  const files = (cellValue(row, property) as FileValue[] | null) ?? [];
  for (const file of files) {
    if (file.id && file.mime?.startsWith('image/')) return fileUrl(file.id);
    if (!file.id && file.url && /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(file.url)) {
      return file.url;
    }
  }
  return null;
}

export const PREVIEW_HEIGHT = { small: 100, medium: 150, large: 200 } as const;

/** The image area of a card: the cover, the first image in the page, or a files property. */
function CardPreview({
  row,
  view,
  snapshot,
  reserve,
}: {
  row: Row;
  view: View;
  snapshot: DatabaseSnapshot;
  /** Keep the area even without an image (gallery cards line up). */
  reserve: boolean;
}) {
  const { platform } = useApp();
  const preview = view.cardPreview;
  const content = useContentImage(preview.kind === 'content' ? row.id : null);
  if (preview.kind === 'none') return null;
  const height = PREVIEW_HEIGHT[view.cardSize];
  let body: ReactNode = null;
  if (preview.kind === 'cover' && row.cover) {
    body = (
      <div
        className="size-full"
        data-testid="card-cover"
        style={{
          ...coverStyle(row.cover, platform.fileUrl),
          ...(view.fitImage && row.cover.kind === 'file'
            ? { backgroundSize: 'contain', backgroundRepeat: 'no-repeat' }
            : {}),
        }}
      />
    );
  } else {
    const src =
      preview.kind === 'content'
        ? content
        : preview.kind === 'property'
          ? fileImage(
              row,
              snapshot.properties.find((p) => p.id === preview.propertyId),
              platform.fileUrl,
            )
          : null;
    if (src) {
      body = (
        <img
          src={src}
          alt=""
          draggable={false}
          data-testid="card-image"
          className={cn('size-full', view.fitImage ? 'object-contain' : 'object-cover')}
        />
      );
    }
  }
  if (!body && !reserve) return null;
  return (
    <div className="overflow-hidden border-b border-line bg-hover/40" style={{ height }}>
      {body}
    </div>
  );
}

// --- Cards -------------------------------------------------------------------------------

export interface CardProps {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  view: View;
  row: Row;
  properties: Property[];
  ctx: DisplayContext;
  layout: 'board' | 'gallery';
  /** Typing the title of a card that was just added. */
  editingTitle: boolean;
  onTitleDone(): void;
  onOpen(): void;
  draggable: boolean;
  dragging?: boolean;
  onDragStart?(event: DragEvent<HTMLElement>): void;
  onDragEnd?(): void;
}

/** A row as a card: preview image, icon and title, and the properties picked for cards. */
export function Card(props: CardProps) {
  const { platform } = useApp();
  const { row, view, ctx } = props;
  const shown = props.properties.filter((p) => !isCellEmpty(row, p) || p.type === 'checkbox');
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="card"
      data-row-id={row.id}
      draggable={props.draggable && !props.editingTitle}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.title);
        props.onDragStart?.(e);
      }}
      onDragEnd={props.onDragEnd}
      onClick={() => !props.editingTitle && props.onOpen()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) props.onOpen();
      }}
      className={cn(
        'overflow-hidden rounded-md bg-surface text-left text-sm shadow-[0_0_0_1px_var(--ws-border),0_2px_4px_rgba(0,0,0,0.04)] outline-none hover:bg-hover/60 focus-visible:ring-2 focus-visible:ring-accent',
        props.dragging && 'opacity-50',
      )}
    >
      <CardPreview
        row={row}
        view={view}
        snapshot={props.snapshot}
        reserve={props.layout === 'gallery'}
      />
      <div className="flex flex-col gap-1.5 px-2.5 py-2">
        {props.editingTitle ? (
          <TextCellEditor
            handle={props.handle}
            row={row}
            property={titleProperty(props.snapshot)}
            ctx={ctx}
            onDone={props.onTitleDone}
            className="-mx-1 rounded border border-accent bg-surface"
          />
        ) : (
          <span className="flex min-w-0 items-start gap-1.5 font-medium">
            {row.icon && (
              <span className="flex h-5 shrink-0 items-center">
                <PageIcon icon={row.icon} size={16} fileUrl={platform.fileUrl} />
              </span>
            )}
            <span
              data-testid="card-title"
              className={cn(
                'min-w-0',
                view.wrap ? 'break-words whitespace-pre-wrap' : 'truncate',
                !row.title && 'text-faint',
              )}
            >
              {row.title || 'Untitled'}
            </span>
          </span>
        )}
        {shown.map((property) => (
          <div
            key={property.id}
            data-testid="card-property"
            data-property-id={property.id}
            title={property.name}
            className="flex min-h-5 min-w-0 items-center text-[13px]"
          >
            <CellDisplay row={row} property={property} ctx={ctx} wrap={view.wrap} variant="panel" />
          </div>
        ))}
      </div>
    </div>
  );
}

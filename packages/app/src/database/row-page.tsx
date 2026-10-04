import { isInTrash, pageMapTitle, pageUrl, restorePage, type PageMeta } from '@workspace/core';
import {
  TITLE_PROPERTY_ID,
  PROPERTY_TYPES,
  addProperty,
  getRowMap,
  isCellEmpty,
  newPropertyName,
  propertyKind,
  restoreRow,
  setCell,
  setRowPageFields,
  setRowTitle,
  trashRow,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type DisplayContext,
  type OpenPagesIn,
  type Property,
  type Row,
} from '@workspace/database';
import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger, cn } from '@workspace/ui';
import { ChevronsRight, Maximize2, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BlockTarget } from '../app';
import { useApp } from '../context';
import { useNavigation } from '../navigation';
import {
  HeroCover,
  PageBody,
  PageHeader,
  PageHero,
  TrashBanner,
  articleProps,
  usePageBody,
  useScrollToBlock,
  type ChromeProps,
  type PageModel,
} from '../page-view';
import { PageMenu } from '../page-menu';
import { duplicateRowWithContent } from './actions';
import {
  CellDisplay,
  PopoverCellEditor,
  PropertyIcon,
  TEXT_TYPES,
  TextCellEditor,
  isEditable,
} from './cells';
import { useDatabase, useDisplayContext } from './hooks';

function rowPageModel(
  handle: DatabaseHandle,
  row: Row,
  databaseId: string,
  databaseTrashed: boolean,
  actor: string,
  restoreDatabase: () => void,
): PageModel {
  const doc = handle.doc;
  const meta: PageMeta = {
    id: row.id,
    kind: 'page',
    parentId: databaseId,
    title: row.title,
    icon: row.icon,
    sortKey: row.sortKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    trashedAt: row.trashedAt,
    cover: row.cover,
    fullWidth: row.fullWidth,
    smallText: row.smallText,
    font: row.font,
    locked: row.locked,
  };
  return {
    id: row.id,
    meta,
    titleText: pageMapTitle(getRowMap(doc, row.id)),
    setTitle: (title) => setRowTitle(doc, row.id, title, actor),
    setIcon: (icon) => setRowPageFields(doc, row.id, { icon }, actor),
    setOptions: (options) => setRowPageFields(doc, row.id, options, actor),
    trashed: row.trashedAt !== null || databaseTrashed,
    restore: () => (row.trashedAt !== null ? restoreRow(doc, row.id) : restoreDatabase()),
  };
}

function useRow(rowId: string, databaseId: string) {
  const { workspace, user } = useApp();
  const loaded = useDatabase(databaseId);
  const row = loaded?.handle.row(rowId);
  if (!loaded || !row) return null;
  const model = rowPageModel(
    loaded.handle,
    row,
    databaseId,
    isInTrash(workspace, databaseId),
    user.id,
    () => restorePage(workspace, databaseId),
  );
  return { ...loaded, row, model };
}

// --- Properties panel --------------------------------------------------------------------

export function PropertiesPanel({
  handle,
  snapshot,
  row,
  editable,
}: {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  row: Row;
  editable: boolean;
}) {
  const ctx = useDisplayContext();
  const [editing, setEditing] = useState<string | null>(null);
  const properties = snapshot.properties.filter((p) => p.id !== TITLE_PROPERTY_ID);
  return (
    <div className="mt-2 border-b border-line pb-3 text-sm" data-testid="row-properties">
      {properties.map((property) => (
        <PropertyRow
          key={property.id}
          handle={handle}
          row={row}
          property={property}
          ctx={ctx}
          editable={editable}
          editing={editing === property.id}
          onEdit={(on) => setEditing(on ? property.id : null)}
        />
      ))}
      {editable && (
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="mt-1 flex h-8 items-center gap-1.5 rounded px-2 text-muted hover:bg-hover"
            >
              <Plus size={14} /> Add a property
            </button>
          </MenuTrigger>
          <MenuContent className="max-h-96 w-56 overflow-y-auto">
            {PROPERTY_TYPES.map((type) => (
              <MenuItem
                key={type}
                icon={<PropertyIcon type={type} />}
                onSelect={() =>
                  addProperty(handle.doc, {
                    name: newPropertyName(handle.doc, propertyKind(type).label),
                    type,
                  })
                }
              >
                {propertyKind(type).label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

function PropertyRow({
  handle,
  row,
  property,
  ctx,
  editable,
  editing,
  onEdit,
}: {
  handle: DatabaseHandle;
  row: Row;
  property: Property;
  ctx: DisplayContext;
  editable: boolean;
  editing: boolean;
  onEdit(on: boolean): void;
}) {
  const { user } = useApp();
  const canEdit = editable && isEditable(property.type);
  const toggle = () =>
    editable && setCell(handle.doc, row.id, property.id, row.values[property.id] !== true, user.id);
  const editorProps = { handle, row, property, ctx, onDone: () => onEdit(false) };
  const empty = isCellEmpty(row, property) && property.type !== 'checkbox';
  return (
    <div className="flex min-h-[34px] items-start gap-1" data-testid="property-row">
      <div className="flex h-[34px] w-40 shrink-0 items-center gap-1.5 px-2 text-muted">
        <PropertyIcon type={property.type} size={15} />
        <span className="truncate">{property.name}</span>
      </div>
      <div
        role={canEdit ? 'button' : undefined}
        aria-label={canEdit ? `Edit ${property.name}` : undefined}
        tabIndex={canEdit ? 0 : undefined}
        onClick={() => canEdit && !editing && onEdit(true)}
        onKeyDown={(e) => {
          if (canEdit && !editing && e.key === 'Enter') onEdit(true);
        }}
        className={cn(
          'relative flex min-h-[34px] min-w-0 flex-1 items-center rounded px-2 py-1.5',
          canEdit && 'cursor-pointer hover:bg-hover',
        )}
      >
        {editing && TEXT_TYPES.includes(property.type) ? (
          <TextCellEditor {...editorProps} className="-mx-2 -my-1.5 rounded border border-accent" />
        ) : empty ? (
          <span className="text-faint">Empty</span>
        ) : (
          <CellDisplay
            row={row}
            property={property}
            ctx={ctx}
            wrap
            variant="panel"
            onToggle={toggle}
          />
        )}
        {editing && !TEXT_TYPES.includes(property.type) && (
          <PopoverCellEditor {...editorProps} anchor={<div className="absolute inset-0" />} />
        )}
      </div>
    </div>
  );
}

// --- Row page content --------------------------------------------------------------------

function RowContent({
  rowId,
  databaseId,
  blockTarget,
}: {
  rowId: string;
  databaseId: string;
  blockTarget?: BlockTarget | null;
}) {
  const found = useRow(rowId, databaseId);
  const { pageDoc, onEditor, focusBody } = usePageBody(rowId);
  const articleRef = useRef<HTMLElement>(null);
  useScrollToBlock(articleRef, pageDoc ? (blockTarget ?? null) : null);
  if (!found) return <div className="h-24" aria-busy="true" />;
  const { handle, snapshot, row, model } = found;
  const editable = !row.locked && !model.trashed;
  return (
    <>
      <HeroCover model={model} editable={editable} />
      <article ref={articleRef} {...articleProps(model.meta)}>
        <PageHero model={model} editable={editable} onEnter={focusBody} />
        <PropertiesPanel handle={handle} snapshot={snapshot} row={row} editable={editable} />
        <div className="mt-4">
          <PageBody pageId={rowId} pageDoc={pageDoc} editable={editable} onEditor={onEditor} />
        </div>
      </article>
    </>
  );
}

function RowMenu({ rowId, databaseId }: { rowId: string; databaseId: string }) {
  const { client, user } = useApp();
  const { navigate } = useNavigation();
  const found = useRow(rowId, databaseId);
  const { pageDoc } = usePageBody(rowId);
  if (!found) return null;
  const { handle, model } = found;
  return (
    <PageMenu
      page={model.meta}
      pageDoc={pageDoc}
      onOptions={model.setOptions}
      onDuplicate={() =>
        void duplicateRowWithContent(client, handle, rowId, user.id).then(navigate)
      }
      onCopyLink={() => void navigator.clipboard.writeText(pageUrl(rowId))}
      onTrash={() => trashRow(handle.doc, rowId)}
    />
  );
}

/** A row opened as the main page. */
export function RowPageView({
  rowId,
  databaseId,
  chrome,
  blockTarget,
}: {
  rowId: string;
  databaseId: string;
  chrome: ChromeProps;
  blockTarget: BlockTarget | null;
}) {
  const { pages } = useApp();
  const found = useRow(rowId, databaseId);
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-surface" data-testid="row-page">
      <PageHeader
        chrome={chrome}
        crumbs={pages.breadcrumb(rowId)}
        locked={found?.row.locked ?? false}
        onUnlock={() => found?.model.setOptions({ locked: false })}
        menu={<RowMenu rowId={rowId} databaseId={databaseId} />}
      />
      {found?.model.trashed && (
        <TrashBanner label="This page is in Trash." onRestore={found.model.restore} />
      )}
      <div className="flex-1 overflow-y-auto" data-testid="page-scroll" data-scroll-root>
        <RowContent rowId={rowId} databaseId={databaseId} blockTarget={blockTarget} />
      </div>
    </main>
  );
}

/** A row opened over the current page: as a side panel or a centered dialog. */
export function RowPeek({
  rowId,
  databaseId,
  mode,
  onClose,
}: {
  rowId: string;
  databaseId: string;
  mode: Exclude<OpenPagesIn, 'fullPage'>;
  onClose(): void;
}) {
  const { navigate } = useNavigation();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      // Escape in a field or menu belongs to it; elsewhere it closes the peek.
      if (
        target?.closest(
          'input, textarea, [contenteditable="true"], [role="menu"], [role="dialog"] [role="listbox"]',
        )
      )
        return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toolbar = (
    <div className="flex h-11 shrink-0 items-center gap-1 px-3">
      <IconButton label="Close" onClick={onClose}>
        {mode === 'sidePeek' ? <ChevronsRight size={18} /> : <X size={18} />}
      </IconButton>
      <IconButton
        label="Open as full page"
        onClick={() => {
          onClose();
          navigate(rowId);
        }}
      >
        <Maximize2 size={16} />
      </IconButton>
      <span className="flex-1" />
      <RowMenu rowId={rowId} databaseId={databaseId} />
    </div>
  );
  const body = (
    <div className="flex-1 overflow-y-auto" data-scroll-root>
      <RowContent rowId={rowId} databaseId={databaseId} />
    </div>
  );

  if (mode === 'center') {
    return (
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Page"
          data-testid="row-peek"
          data-mode="center"
          className="flex h-[min(85vh,900px)] w-[min(970px,calc(100vw-48px))] flex-col overflow-hidden rounded-xl bg-surface shadow-menu"
        >
          {toolbar}
          {body}
        </div>
      </div>
    );
  }
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Page"
      data-testid="row-peek"
      data-mode="sidePeek"
      className="fixed inset-y-0 right-0 z-40 flex w-[min(720px,calc(100vw-64px))] flex-col border-l border-line bg-surface shadow-menu"
    >
      {toolbar}
      {body}
    </div>
  );
}

import {
  getPage,
  isInTrash,
  pageMapTitle,
  pageUrl,
  readBlocks,
  restorePage,
  type PageMeta,
  roleAllows,
} from '@workspace/core';
import { PageIcon } from '@workspace/editor';
import type * as Y from 'yjs';
import { useDocVersion } from '../hooks';
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
  setMeta,
  setRowPageFields,
  setRowTitle,
  templatesOf,
  trashRow,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type DisplayContext,
  type OpenPagesIn,
  type Property,
  type Row,
} from '@workspace/database';
import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger, cn } from '@workspace/ui';
import { ChevronDown, ChevronsRight, Eye, EyeOff, Maximize2, Plus, X } from 'lucide-react';
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
import { applyTemplateToRow, duplicateRowWithContent } from './actions';
import { FormulaEditor } from './formula-editor';
import { RelationSetup, RollupSetup, type SetupRequest } from './relation-setup';
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
  // From the snapshot (not the handle), so formula values are included.
  const row = loaded?.handle.row(rowId) && loaded.snapshot.rows.find((r) => r.id === rowId);
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
  const base = useDisplayContext();
  const ctx = { ...base, pages: snapshot.related };
  const [editing, setEditing] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [formulaFor, setFormulaFor] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupRequest | null>(null);
  const all = snapshot.properties.filter((p) => p.id !== TITLE_PROPERTY_ID);
  const hideEmpty = snapshot.meta.hideEmptyProperties;
  // Empty properties fold away (unless being edited) when the database asks for it.
  const isEmpty = (p: Property) => isCellEmpty(row, p) && p.type !== 'checkbox';
  const hidden = hideEmpty && !showAll ? all.filter((p) => isEmpty(p) && p.id !== editing) : [];
  const properties = all.filter((p) => !hidden.includes(p));
  const emptyCount = all.filter(isEmpty).length;
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
          onEdit={(on) => {
            if (on && property.type === 'formula') setFormulaFor(property.id);
            else setEditing(on ? property.id : null);
          }}
        />
      ))}
      {formulaFor && snapshot.properties.find((p) => p.id === formulaFor) && (
        <FormulaEditor
          handle={handle}
          snapshot={snapshot}
          property={snapshot.properties.find((p) => p.id === formulaFor)!}
          row={snapshot.rows.find((r) => r.id === row.id)}
          ctx={ctx}
          onClose={() => setFormulaFor(null)}
        />
      )}
      {setup?.kind === 'relation' && (
        <RelationSetup handle={handle} request={setup} ctx={ctx} onClose={() => setSetup(null)} />
      )}
      {setup?.kind === 'rollup' && (
        <RollupSetup
          handle={handle}
          properties={snapshot.properties}
          propertyId={setup.propertyId}
          onClose={() => setSetup(null)}
        />
      )}
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="flex h-8 items-center gap-1.5 rounded px-2 text-muted hover:bg-hover"
        >
          <ChevronDown size={14} /> {hidden.length} more{' '}
          {hidden.length === 1 ? 'property' : 'properties'}
        </button>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {editable && !snapshot.meta.lockProperties && (
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
                  onSelect={() => {
                    if (type === 'relation') {
                      setSetup({ kind: 'relation', mode: 'add' });
                      return;
                    }
                    const id = addProperty(handle.doc, {
                      name: newPropertyName(handle.doc, propertyKind(type).label),
                      type,
                    });
                    if (type === 'rollup') setSetup({ kind: 'rollup', propertyId: id });
                    if (type === 'formula') setFormulaFor(id);
                  }}
                >
                  {propertyKind(type).label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        {editable && (emptyCount > 0 || hideEmpty) && (
          <button
            type="button"
            onClick={() => {
              setMeta(handle.doc, { hideEmptyProperties: !hideEmpty });
              setShowAll(false);
            }}
            className="mt-1 flex h-8 items-center gap-1.5 rounded px-2 text-muted hover:bg-hover"
          >
            {hideEmpty ? <Eye size={14} /> : <EyeOff size={14} />}
            {hideEmpty ? 'Show empty properties' : 'Hide empty properties'}
          </button>
        )}
      </div>
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
  // Formulas are edited as a whole (their expression), from the value too.
  const canEdit = editable && (isEditable(property.type) || property.type === 'formula');
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
  const { workspace, pages } = useApp();
  const { pageDoc, onEditor, focusBody } = usePageBody(rowId);
  const articleRef = useRef<HTMLElement>(null);
  useScrollToBlock(articleRef, pageDoc ? (blockTarget ?? null) : null);
  if (!found) return <div className="h-24" aria-busy="true" />;
  const { handle, snapshot, row, model } = found;
  // As its database: read-only for someone who may only view or comment.
  const editable = !row.locked && !model.trashed && roleAllows(pages.role(rowId), 'edit');
  return (
    <>
      {row.isTemplate && (
        <div
          className="flex h-9 items-center justify-center bg-accent/10 text-sm text-accent"
          data-testid="template-banner"
        >
          You’re editing a template in {getPage(workspace, databaseId)?.title || 'Untitled'}
        </div>
      )}
      <HeroCover model={model} editable={editable} />
      <article ref={articleRef} {...articleProps(model.meta)}>
        <PageHero model={model} editable={editable} onEnter={focusBody} />
        <PropertiesPanel handle={handle} snapshot={snapshot} row={row} editable={editable} />
        {editable && !row.isTemplate && pageDoc && (
          <TemplatePicker handle={handle} snapshot={snapshot} rowId={rowId} pageDoc={pageDoc} />
        )}
        <div className="mt-4">
          <PageBody pageId={rowId} pageDoc={pageDoc} editable={editable} onEditor={onEditor} />
        </div>
      </article>
    </>
  );
}

/** On an empty row page: start it from one of the database's templates. */
function TemplatePicker({
  handle,
  snapshot,
  rowId,
  pageDoc,
}: {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  rowId: string;
  pageDoc: Y.Doc;
}) {
  const { client, user, platform } = useApp();
  useDocVersion(pageDoc);
  const templates = templatesOf(snapshot);
  const empty = readBlocks(pageDoc).every(
    (b) => b.type === 'paragraph' && !b.text && b.children.length === 0,
  );
  if (!empty || templates.length === 0) return null;
  return (
    <div className="mt-4 text-sm" data-testid="template-picker">
      <p className="mb-1 text-muted">Start from a template</p>
      <div className="flex flex-wrap gap-1.5">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() =>
              void applyTemplateToRow(client, handle, rowId, t.id, user.id, platform.snapshot)
            }
            className="flex h-8 items-center gap-1.5 rounded border border-line px-2 hover:bg-hover"
          >
            <PageIcon icon={t.icon} size={14} fileUrl={platform.fileUrl} className="text-muted" />
            {t.title || 'Untitled'}
          </button>
        ))}
      </div>
    </div>
  );
}

function RowMenu({ rowId, databaseId }: { rowId: string; databaseId: string }) {
  const { client, user, databases } = useApp();
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
        void duplicateRowWithContent(client, databases, handle, rowId, user.id).then(navigate)
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
        access={pages.role(rowId)}
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

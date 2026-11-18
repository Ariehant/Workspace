/**
 * Row page layouts (Notion's "Customize layout"), set once per database: properties pinned
 * under the title, the rest in the page, folded, or in a side panel, and relations shown as
 * sections listing the linked pages.
 */
import {
  MAX_PINNED,
  TITLE_PROPERTY_ID,
  isCellEmpty,
  relationIds,
  setMeta,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type DisplayContext,
  type Property,
  type Row,
  type RowLayout,
} from '@workspace/database';
import { PageIcon } from '@workspace/editor';
import { Button, Dialog, DialogContent, IconButton } from '@workspace/ui';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../context';
import { useNavigation } from '../navigation';
import { writeCell } from './actions';
import { CellDisplay, PopoverCellEditor, PropertyIcon } from './cells';
import { useDatabase } from './hooks';

/** The linked pages of a relation, as a section of the row page. */
export function RelationSection({
  handle,
  row,
  property,
  ctx,
  editable,
}: {
  handle: DatabaseHandle;
  row: Row;
  property: Property;
  ctx: DisplayContext;
  editable: boolean;
}) {
  const { databases, user, platform } = useApp();
  const { openRow } = useNavigation();
  const targetId = property.config.databaseId ?? '';
  const target = useDatabase(targetId);
  const [adding, setAdding] = useState(false);
  const linked = relationIds(row.values[property.id]);
  // A few of the linked pages' properties, beside their titles.
  const shown = (target?.snapshot.properties ?? [])
    .filter((p) => p.id !== TITLE_PROPERTY_ID && p.type !== 'relation' && p.type !== 'button')
    .slice(0, 3);
  const rowOf = (id: string) => target?.snapshot.rows.find((r) => r.id === id);
  const targetCtx = { ...ctx, pages: target?.snapshot.related ?? ctx.pages };

  return (
    <section className="mt-6 text-sm" data-testid="relation-section" aria-label={property.name}>
      {/* The page's title is its h1. */}
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <PropertyIcon type="relation" />
        {property.name}
        <span className="text-xs font-normal text-faint">{linked.length}</span>
      </h2>
      <ul className="divide-y divide-line border-y border-line">
        {linked.map((id) => {
          const page = ctx.pages?.get(id);
          const related = rowOf(id);
          return (
            <li
              key={id}
              className="group/rel flex min-h-9 items-center gap-3 px-1"
              data-testid="relation-section-page"
            >
              <button
                type="button"
                onClick={() => openRow(id, targetId, 'sidePeek')}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:underline"
              >
                <PageIcon icon={page?.icon ?? null} size={14} fileUrl={platform.fileUrl} />
                <span className="truncate">{page?.title || 'Untitled'}</span>
              </button>
              {related &&
                shown.map((p) =>
                  isCellEmpty(related, p) ? null : (
                    <span key={p.id} className="max-w-40 shrink-0 truncate text-muted">
                      <CellDisplay row={related} property={p} ctx={targetCtx} variant="panel" />
                    </span>
                  ),
                )}
              {editable && (
                <IconButton
                  label={`Remove ${page?.title || 'Untitled'}`}
                  size="sm"
                  className="opacity-0 group-hover/rel:opacity-100 focus-visible:opacity-100"
                  onClick={() =>
                    writeCell(
                      databases,
                      handle,
                      row.id,
                      property,
                      linked.filter((x) => x !== id),
                      user.id,
                    )
                  }
                >
                  <X size={14} />
                </IconButton>
              )}
            </li>
          );
        })}
        {linked.length === 0 && <li className="px-1 py-2 text-faint">No linked pages</li>}
      </ul>
      {editable && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-1 flex h-8 items-center gap-1.5 rounded px-2 text-muted hover:bg-hover"
          >
            <Plus size={14} /> Add a page
          </button>
          {adding && (
            <PopoverCellEditor
              handle={handle}
              row={handle.row(row.id) ?? row}
              property={property}
              ctx={ctx}
              onDone={() => setAdding(false)}
              anchor={<div className="absolute bottom-0 left-0 h-px w-60" />}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** Choose the layout of every row page of a database. */
export function LayoutDialog({
  handle,
  snapshot,
  onClose,
}: {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  onClose(): void;
}) {
  const current = snapshot.meta.layout;
  const [layout, setLayout] = useState<RowLayout>(
    current ?? { pinned: [], properties: 'page', relationSections: [] },
  );
  const properties = snapshot.properties.filter((p) => p.id !== TITLE_PROPERTY_ID);
  const relations = properties.filter((p) => p.type === 'relation');
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Customize layout" data-testid="layout-dialog" className="w-[480px]">
        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto p-4 pt-2 text-sm">
          <p className="text-muted">For every page of this database.</p>
          <fieldset>
            <legend className="mb-1 font-medium">
              Pinned under the title{' '}
              <span className="font-normal text-faint">(up to {MAX_PINNED})</span>
            </legend>
            {properties.map((p) => {
              const on = layout.pinned.includes(p.id);
              return (
                <label key={p.id} className="flex h-7 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && layout.pinned.length >= MAX_PINNED}
                    onChange={(e) =>
                      setLayout({
                        ...layout,
                        pinned: toggle(layout.pinned, p.id, e.target.checked),
                      })
                    }
                  />
                  <PropertyIcon type={p.type} />
                  {p.name}
                </label>
              );
            })}
          </fieldset>
          <fieldset>
            <legend className="mb-1 font-medium">The other properties</legend>
            {(
              [
                ['page', 'In the page, above the content'],
                ['collapsed', 'Folded behind “Properties”'],
                ['side', 'In a side panel (wide windows)'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex h-7 items-center gap-2">
                <input
                  type="radio"
                  name="layout-properties"
                  checked={layout.properties === value}
                  onChange={() => setLayout({ ...layout, properties: value })}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {relations.length > 0 && (
            <fieldset>
              <legend className="mb-1 font-medium">Relations as sections of the page</legend>
              {relations.map((p) => (
                <label key={p.id} className="flex h-7 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={layout.relationSections.includes(p.id)}
                    onChange={(e) =>
                      setLayout({
                        ...layout,
                        relationSections: toggle(layout.relationSections, p.id, e.target.checked),
                      })
                    }
                  />
                  <PropertyIcon type={p.type} />
                  {p.name}
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex justify-end gap-2">
            {current && (
              <Button
                onClick={() => {
                  setMeta(handle.doc, { layout: null });
                  onClose();
                }}
              >
                Reset
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="layout-save"
              onClick={() => {
                setMeta(handle.doc, { layout });
                onClose();
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

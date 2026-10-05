import { getPage, isInTrash, listPages } from '@workspace/core';
import {
  changePropertyType,
  createRelation,
  readProperties,
  isLiveRow,
  renameProperty,
  rollupCalculationsFor,
  setPropertyConfig,
  updateRelation,
  type DatabaseHandle,
  type DisplayContext,
  type Property,
  type RelatedPage,
  type RollupCalculation,
} from '@workspace/database';
import { Button, Dialog, DialogContent } from '@workspace/ui';
import { useState, type ReactNode } from 'react';
import { useApp } from '../context';
import { useDatabase } from './hooks';

/** What a setup dialog is for: a new relation, a type change, or editing one. */
export type SetupRequest =
  | { kind: 'relation'; mode: 'add'; afterId?: string }
  | { kind: 'relation'; mode: 'change' | 'edit'; propertyId: string }
  | { kind: 'rollup'; propertyId: string };

const databaseTitle = (title: string | undefined) => title || 'Untitled';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex h-9 items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

const selectClass =
  'h-8 max-w-64 min-w-40 rounded border border-line bg-transparent px-2 text-fg outline-none focus:border-accent';

/** Relation settings: the database it links to, a one-page limit, and the other side. */
export function RelationSetup({
  handle,
  request,
  ctx,
  onClose,
}: {
  handle: DatabaseHandle;
  request: Extract<SetupRequest, { kind: 'relation' }>;
  ctx: DisplayContext;
  onClose(): void;
}) {
  const { workspace, databases } = useApp();
  const existing =
    request.mode === 'add'
      ? undefined
      : readProperties(handle.doc).find((p) => p.id === request.propertyId);
  const editing = request.mode === 'edit' && existing?.type === 'relation';
  const thisTitle = databaseTitle(getPage(workspace, handle.id)?.title);
  const choices = listPages(workspace)
    .filter((p) => p.kind === 'database' && p.id !== handle.id && !isInTrash(workspace, p.id))
    .sort((a, b) => a.title.localeCompare(b.title));
  const [targetId, setTargetId] = useState(
    editing ? (existing.config.databaseId ?? '') : (choices[0]?.id ?? handle.id),
  );
  const [limitOne, setLimitOne] = useState(editing ? existing.config.limitOne === true : false);
  const syncedId = editing ? existing.config.syncedPropertyId : null;
  const targetDoc = databases.get(targetId)?.doc;
  const syncedName =
    syncedId && targetDoc
      ? (readProperties(targetDoc).find((p) => p.id === syncedId)?.name ?? '')
      : '';
  const [twoWay, setTwoWay] = useState(!!syncedId);
  const [otherName, setOtherName] = useState(syncedName || `Related to ${thisTitle}`);
  const [busy, setBusy] = useState(false);
  const targetTitle =
    targetId === handle.id ? 'This database' : databaseTitle(getPage(workspace, targetId)?.title);

  const save = async () => {
    setBusy(true);
    try {
      await databases.load(targetId);
      const resolve = databases.resolveDoc;
      const other = twoWay ? { name: otherName.trim() || `Related to ${thisTitle}` } : null;
      if (request.mode === 'add') {
        createRelation(resolve, {
          databaseId: handle.id,
          name:
            targetId === handle.id ? 'Related' : databaseTitle(getPage(workspace, targetId)?.title),
          targetId,
          twoWay: other,
          limitOne,
          afterId: request.afterId,
        });
      } else if (editing) {
        updateRelation(resolve, handle.id, request.propertyId, { limitOne, twoWay: other });
        const synced = readProperties(handle.doc).find((p) => p.id === request.propertyId)?.config
          .syncedPropertyId;
        const doc = databases.get(targetId)?.doc;
        if (other && synced && doc && other.name !== syncedName && syncedName) {
          renameProperty(doc, synced, other.name);
        }
      } else {
        // A type change: values become links to pages with the same titles.
        const target = databases.get(targetId)!.snapshot();
        const pages = new Map<string, RelatedPage>(
          target.rows
            .filter(isLiveRow)
            .map((r) => [r.id, { id: r.id, title: r.title, icon: r.icon, databaseId: targetId }]),
        );
        changePropertyType(
          handle.doc,
          request.propertyId,
          'relation',
          { ...ctx, pages },
          { databaseId: targetId, syncedPropertyId: null, limitOne },
        );
        if (other) updateRelation(resolve, handle.id, request.propertyId, { twoWay: other });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={editing ? `Edit relation: ${existing.name}` : 'New relation'}
        className="w-[min(440px,calc(100vw-32px))]"
        data-testid="relation-setup"
      >
        <div className="space-y-1 px-4 py-3">
          <Field label="Related to">
            <select
              aria-label="Related to"
              value={targetId}
              disabled={editing}
              onChange={(e) => setTargetId(e.target.value)}
              className={selectClass}
            >
              <option value={handle.id}>This database ({thisTitle})</option>
              {choices.map((p) => (
                <option key={p.id} value={p.id}>
                  {databaseTitle(p.title)}
                </option>
              ))}
              {editing && targetId !== handle.id && !choices.some((c) => c.id === targetId) && (
                <option value={targetId}>Deleted database</option>
              )}
            </select>
          </Field>
          <Field label="Limit">
            <select
              aria-label="Limit"
              value={limitOne ? 'one' : 'none'}
              onChange={(e) => setLimitOne(e.target.value === 'one')}
              className={selectClass}
            >
              <option value="none">No limit</option>
              <option value="one">1 page</option>
            </select>
          </Field>
          <Field label={`Show on ${targetTitle}`}>
            <input
              type="checkbox"
              role="switch"
              aria-label="Two-way relation"
              checked={twoWay}
              onChange={(e) => setTwoWay(e.target.checked)}
              className="size-4 accent-[var(--ws-accent)]"
            />
          </Field>
          {twoWay && (
            <Field label={`Property name on ${targetTitle}`}>
              <input
                aria-label="Related property name"
                value={otherName}
                onChange={(e) => setOtherName(e.target.value)}
                className={selectClass}
              />
            </Field>
          )}
          {twoWay && targetId === handle.id && (
            <p className="text-xs text-muted">
              Both properties are added to this database and stay in sync.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !targetId}
            onClick={() => void save()}
            className="disabled:opacity-50"
          >
            {request.mode === 'add' ? 'Add relation' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Rollup settings: which relation, which property over there, and what to calculate. */
export function RollupSetup({
  handle,
  properties,
  propertyId,
  onClose,
}: {
  handle: DatabaseHandle;
  /** This database's properties. */
  properties: readonly Property[];
  propertyId: string;
  onClose(): void;
}) {
  const stored = readProperties(handle.doc).find((p) => p.id === propertyId);
  const relations = properties.filter((p) => p.type === 'relation');
  const relation = relations.find((p) => p.id === stored?.config.relationId);
  const target = useDatabase(relation?.config.databaseId ?? '');
  if (!stored) return null;
  const targetProperties = relation && target ? target.snapshot.properties : [];
  const targetProperty = targetProperties.find((p) => p.id === stored.config.targetPropertyId);
  const calculations = rollupCalculationsFor(targetProperty);
  const calculation = stored.config.calculation ?? 'showOriginal';

  const update = (changes: {
    relationId?: string;
    targetPropertyId?: string;
    calculation?: RollupCalculation;
  }) => {
    const config = { ...stored.config, ...changes };
    // A calculation the new property doesn't offer goes back to "Show original".
    if (changes.targetPropertyId !== undefined || changes.relationId !== undefined) {
      const next =
        changes.relationId !== undefined && changes.relationId !== stored.config.relationId
          ? undefined
          : targetProperties.find((p) => p.id === config.targetPropertyId);
      if (!next) delete config.targetPropertyId;
      if (!rollupCalculationsFor(next).some((c) => c.id === config.calculation)) {
        config.calculation = 'showOriginal';
      }
    }
    setPropertyConfig(handle.doc, propertyId, config);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Rollup: ${stored.name}`}
        className="w-[min(440px,calc(100vw-32px))]"
        data-testid="rollup-setup"
      >
        <div className="space-y-1 px-4 py-3">
          {relations.length === 0 && (
            <p className="py-1 text-muted">Add a relation first: rollups read related pages.</p>
          )}
          <Field label="Relation">
            <select
              aria-label="Relation"
              value={relation?.id ?? ''}
              onChange={(e) => update({ relationId: e.target.value })}
              className={selectClass}
            >
              <option value="" disabled>
                Select a relation
              </option>
              {relations.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Property">
            <select
              aria-label="Property"
              value={targetProperty?.id ?? ''}
              disabled={!relation}
              onChange={(e) => update({ targetPropertyId: e.target.value })}
              className={selectClass}
            >
              <option value="" disabled>
                Select a property
              </option>
              {targetProperties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Calculate">
            <select
              aria-label="Calculate"
              value={calculation}
              disabled={!targetProperty}
              onChange={(e) => update({ calculation: e.target.value as RollupCalculation })}
              className={selectClass}
            >
              {calculations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex justify-end border-t border-line px-4 py-3">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

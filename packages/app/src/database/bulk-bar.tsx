/**
 * Bulk edits (Notion's row selection): what the picked rows of a table can do together. Set a
 * property for all of them (one undo step), duplicate them, copy their links, or delete them.
 */
import { pageUrl } from '@workspace/core';
import {
  TITLE_PROPERTY_ID,
  propertyKind,
  togglesOnClick,
  trashRow,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type DisplayContext,
  type Property,
  type Row,
} from '@workspace/database';
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@workspace/ui';
import { Copy, Link2, PencilLine, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useApp } from '../context';
import { duplicateRowWithContent, writeCell } from './actions';
import { PopoverCellEditor, PropertyIcon, TEXT_TYPES, isEditable as isEditableType } from './cells';

export function BulkBar({
  handle,
  snapshot,
  rows,
  ctx,
  editable,
  onClear,
}: {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  rows: Row[];
  ctx: DisplayContext;
  editable: boolean;
  onClear(): void;
}) {
  const { client, user, databases } = useApp();
  const [editing, setEditing] = useState<Property | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const properties = snapshot.properties.filter(
    (p) => p.id !== TITLE_PROPERTY_ID && (isEditableType(p.type) || togglesOnClick(p)),
  );
  const first = rows[0];

  /** Give every picked row this property's value (as one transaction). */
  const setAll = (property: Property, value: unknown, except?: string) => {
    handle.doc.transact(() => {
      for (const row of rows) {
        if (row.id === except) continue;
        writeCell(databases, handle, row.id, property, structuredClone(value), user.id);
      }
    });
  };

  const choose = (property: Property) => {
    if (property.type === 'checkbox') return; // its own two choices
    handle.beginUndoGroup();
    setEditing(property);
  };

  /** The editor closed: what it set on the first row goes to the others too. */
  const finish = () => {
    const property = editing;
    setEditing(null);
    if (property && first && !TEXT_TYPES.includes(property.type)) {
      const value = handle.row(first.id)?.values[property.id];
      setAll(property, value ?? null, first.id);
    }
    handle.endUndoGroup();
  };

  return (
    <div
      ref={anchor}
      role="toolbar"
      aria-label="Selected pages"
      data-testid="bulk-bar"
      className="relative mb-2 flex flex-wrap items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-sm shadow-sm"
    >
      <span className="mr-2 font-medium text-accent" data-testid="bulk-count">
        {rows.length} selected
      </span>
      {editable && (
        <Menu modal={false}>
          <MenuTrigger asChild>
            <Button variant="ghost">
              <PencilLine size={14} /> Edit property
            </Button>
          </MenuTrigger>
          <MenuContent className="max-h-80 w-56 overflow-y-auto" data-testid="bulk-properties">
            {properties.map((p) =>
              p.type === 'checkbox' ? (
                [true, false].map((on) => (
                  <MenuItem
                    key={`${p.id}:${on}`}
                    icon={<PropertyIcon type={p.type} />}
                    onSelect={() => setAll(p, on)}
                  >
                    {p.name}: {on ? 'checked' : 'unchecked'}
                  </MenuItem>
                ))
              ) : (
                <MenuItem
                  key={p.id}
                  icon={<PropertyIcon type={p.type} />}
                  onSelect={() => choose(p)}
                >
                  {p.name}
                </MenuItem>
              ),
            )}
          </MenuContent>
        </Menu>
      )}
      {editable && (
        <Button
          variant="ghost"
          onClick={() => {
            for (const row of rows) {
              void duplicateRowWithContent(client, databases, handle, row.id, user.id);
            }
            onClear();
          }}
        >
          <Copy size={14} /> Duplicate
        </Button>
      )}
      <Button
        variant="ghost"
        onClick={() =>
          void navigator.clipboard.writeText(rows.map((r) => pageUrl(r.id)).join('\n'))
        }
      >
        <Link2 size={14} /> Copy links
      </Button>
      {editable && (
        <Button
          variant="ghost"
          onClick={() => {
            handle.doc.transact(() => {
              for (const row of rows) trashRow(handle.doc, row.id);
            });
            onClear();
          }}
        >
          <Trash2 size={14} /> Delete
        </Button>
      )}
      <span className="flex-1" />
      <Button variant="ghost" aria-label="Clear selection" onClick={onClear}>
        <X size={14} />
      </Button>

      {/* Lists, dates, people, files, relations: their usual editor, on the first row. */}
      {editing && first && !TEXT_TYPES.includes(editing.type) && (
        <PopoverCellEditor
          handle={handle}
          row={handle.row(first.id) ?? first}
          property={editing}
          ctx={ctx}
          onDone={finish}
          anchor={<div className="absolute inset-x-0 bottom-0" />}
        />
      )}
      {/* Text, numbers, links: typed once, parsed as pasting would. */}
      {editing && TEXT_TYPES.includes(editing.type) && (
        <TextValue
          property={editing}
          onApply={(text) => {
            const parsed = propertyKind(editing.type).parse(text, editing, ctx);
            setAll(editing, parsed.value);
            finish();
          }}
          onCancel={finish}
        />
      )}
    </div>
  );
}

function TextValue({
  property,
  onApply,
  onCancel,
}: {
  property: Property;
  onApply(text: string): void;
  onCancel(): void;
}) {
  const [text, setText] = useState('');
  return (
    <Popover open onOpenChange={(open) => !open && onCancel()}>
      <PopoverAnchor asChild>
        <div className="absolute inset-x-0 bottom-0" />
      </PopoverAnchor>
      <PopoverContent aria-label={`Set ${property.name}`} className="w-72" data-testid="bulk-text">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onApply(text);
          }}
        >
          <input
            autoFocus
            aria-label={property.name}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            className="h-8 min-w-0 flex-1 rounded border border-line bg-surface px-2 outline-none focus:border-accent"
          />
          <Button type="submit" variant="primary">
            Set
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

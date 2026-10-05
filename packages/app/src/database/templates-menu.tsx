import {
  addTemplate,
  defaultTemplate,
  deleteTemplate,
  duplicateTemplate,
  setMeta,
  templatesOf,
  updateView,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type View,
} from '@workspace/database';
import { PageIcon } from '@workspace/editor';
import {
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@workspace/ui';
import {
  ChevronDown,
  Copy,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../context';
import { newRow } from './actions';

/** The "New" button and its templates dropdown (new from a template, edit, defaults). */
export function NewButton({
  handle,
  snapshot,
  view,
  databaseTitle,
  onOpenRow,
}: {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  view: View;
  databaseTitle: string;
  onOpenRow(rowId: string): void;
}) {
  const { user, client, platform } = useApp();
  const [open, setOpen] = useState(false);
  const doc = handle.doc;
  const templates = templatesOf(snapshot);
  const current = defaultTemplate(snapshot, view);
  const create = (templateId?: string | null) => {
    setOpen(false);
    onOpenRow(newRow(client, handle, snapshot, view, { actor: user.id, templateId }));
  };
  const edit = (id: string) => {
    setOpen(false);
    onOpenRow(id);
  };
  // `id` null: an empty page.
  const setDefault = (id: string | null, scope: 'view' | 'all') => {
    if (scope === 'view') updateView(doc, view.id, { defaultTemplateId: id ?? 'none' });
    else {
      setMeta(doc, { defaultTemplateId: id });
      updateView(doc, view.id, { defaultTemplateId: null });
    }
  };
  const optionsMenu = (id: string | null, label: string) => (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <IconButton
          label={`${label} options`}
          size="sm"
          className="opacity-0 group-hover/t:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal size={14} />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="start" side="right" data-testid="template-options">
        <MenuItem icon={<Star size={14} />} onSelect={() => setDefault(id, 'view')}>
          Set as default for this view
        </MenuItem>
        <MenuItem icon={<Star size={14} />} onSelect={() => setDefault(id, 'all')}>
          Set as default for all views
        </MenuItem>
        {id && (
          <>
            <MenuSeparator />
            <MenuItem icon={<Pencil size={14} />} onSelect={() => edit(id)}>
              Edit
            </MenuItem>
            <MenuItem
              icon={<Copy size={14} />}
              onSelect={() => duplicateTemplate(doc, id, user.id)}
            >
              Duplicate
            </MenuItem>
            <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => deleteTemplate(doc, id)}>
              Delete
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
  const badge = <span className="rounded bg-hover px-1 text-[11px] text-muted">Default</span>;
  return (
    <div className="ml-1 flex h-7 items-stretch overflow-hidden rounded-md bg-accent text-sm font-medium text-accent-fg">
      <button type="button" onClick={() => create()} className="px-2.5 hover:brightness-110">
        New
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Choose a template"
            className="border-l border-accent-fg/30 px-1 hover:brightness-110"
          >
            <ChevronDown size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-1 text-sm" data-testid="templates-menu">
          <p className="px-2 py-1 text-xs text-muted">Templates for {databaseTitle}</p>
          {templates.map((t) => (
            <div
              key={t.id}
              className="group/t flex h-8 items-center gap-1 rounded px-1 hover:bg-hover"
              data-testid="template-item"
            >
              <button
                type="button"
                onClick={() => create(t.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left"
              >
                <PageIcon
                  icon={t.icon}
                  size={16}
                  fileUrl={platform.fileUrl}
                  className="shrink-0 text-muted"
                />
                <span className="truncate">{t.title || 'Untitled'}</span>
                {current?.id === t.id && badge}
              </button>
              {optionsMenu(t.id, t.title || 'Untitled')}
            </div>
          ))}
          <div
            className="group/t flex h-8 items-center gap-1 rounded px-1 hover:bg-hover"
            data-testid="template-item"
          >
            <button
              type="button"
              onClick={() => create(null)}
              className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left"
            >
              <FileText size={16} className="shrink-0 text-muted" />
              <span className="truncate">Empty page</span>
              {!current && templates.length > 0 && badge}
            </button>
            {templates.length > 0 && optionsMenu(null, 'Empty page')}
          </div>
          <MenuLikeSeparator />
          <button
            type="button"
            onClick={() => edit(addTemplate(doc, { actor: user.id }))}
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-muted hover:bg-hover"
          >
            <Plus size={14} /> New template
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const MenuLikeSeparator = () => <div className="my-1 h-px bg-line" />;

import type { PageId } from '@workspace/core';
import {
  cellText,
  isLiveRow,
  readDatabase,
  viewColumns,
  type PageBundle,
  type RelatedPage,
} from '@workspace/database';
import { PageEditor, PageIcon, type EditorServices } from '@workspace/editor';
import { Button, Dialog, DialogContent, cn } from '@workspace/ui';
import { FileText, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { useApp } from '../context';
import { useEditorServices } from '../editor-services';
import { useDoc } from '../hooks';
import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from './builtin';
import {
  TEMPLATES_DOC_ID,
  applyTemplate,
  deleteSavedTemplate,
  listSavedTemplates,
  templatesMap,
} from './store';

const MINE = 'My templates';
type Category = (typeof TEMPLATE_CATEGORIES)[number] | typeof MINE;

interface Entry {
  id: string;
  name: string;
  icon: string | null;
  description: string;
  load(): Promise<PageBundle>;
  saved: boolean;
}

// Built-in templates are built once per session, when first previewed.
const built = new Map<string, Promise<PageBundle>>();
const builtIn = (id: string, build: () => Promise<PageBundle>) => {
  let bundle = built.get(id);
  if (!bundle) built.set(id, (bundle = build()));
  return bundle;
};

function useSavedTemplates(doc: Y.Doc | null) {
  const key = useSyncExternalStore(
    (onChange) => {
      if (!doc) return () => {};
      const map = templatesMap(doc);
      map.observe(onChange);
      return () => map.unobserve(onChange);
    },
    () => (doc ? [...templatesMap(doc).keys()].join() : ''),
  );
  // `key` changes exactly when the list does.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (doc ? listSavedTemplates(doc) : []), [doc, key]);
}

/** The templates gallery: built-in templates by category and the user's own. */
export function TemplatesGallery({
  onUse,
  onClose,
}: {
  /** A template was copied into the workspace as this page. */
  onUse(pageId: PageId): void;
  onClose(): void;
}) {
  const { client, workspace } = useApp();
  const store = useDoc(client, TEMPLATES_DOC_ID);
  const saved = useSavedTemplates(store);
  const [category, setCategory] = useState<Category>(TEMPLATE_CATEGORIES[0]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const entries: Entry[] =
    category === MINE
      ? saved.map((t) => ({
          id: t.id,
          name: t.name,
          icon: t.icon,
          description: `Saved ${new Date(t.createdAt).toLocaleDateString()}`,
          load: () => Promise.resolve(t.bundle),
          saved: true,
        }))
      : BUILTIN_TEMPLATES.filter((t) => t.category === category).map((t) => ({
          ...t,
          load: () => builtIn(t.id, t.build),
          saved: false,
        }));
  const selected = entries.find((e) => e.id === selectedId) ?? entries[0] ?? null;

  const [bundle, setBundle] = useState<{ id: string; bundle: PageBundle } | null>(null);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    void selected.load().then((b) => live && setBundle({ id: selected.id, bundle: b }));
    return () => {
      live = false;
    };
    // `selected` is rebuilt each render; its id identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, category]);
  const preview = bundle && selected && bundle.id === selected.id ? bundle.bundle : null;

  const use = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const id = await applyTemplate(client, workspace, preview);
      onUse(id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Templates"
        className="top-[6vh] flex h-[84vh] w-[min(1080px,calc(100vw-32px))] flex-col"
        data-testid="templates-dialog"
      >
        <div className="flex min-h-0 flex-1 border-t border-line">
          <div
            className="w-44 shrink-0 border-r border-line p-1"
            role="tablist"
            aria-label="Categories"
          >
            {[...TEMPLATE_CATEGORIES, MINE].map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={c === category}
                onClick={() => {
                  setCategory(c as Category);
                  setSelectedId(null);
                }}
                className={cn(
                  'flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-hover',
                  c === category && 'bg-active font-medium',
                )}
              >
                <span className="flex-1">{c}</span>
                {c === MINE && saved.length > 0 && (
                  <span className="text-xs text-faint">{saved.length}</span>
                )}
              </button>
            ))}
          </div>
          <div
            className="w-64 shrink-0 overflow-y-auto border-r border-line p-1"
            role="listbox"
            aria-label="Templates"
          >
            {entries.length === 0 && (
              <p className="p-2 text-sm text-muted">
                No templates yet. Use “Save as template” in a page’s ··· menu to add one.
              </p>
            )}
            {entries.map((e) => (
              <button
                key={e.id}
                type="button"
                role="option"
                aria-selected={e.id === selected?.id}
                data-testid="template-item"
                onClick={() => setSelectedId(e.id)}
                className={cn(
                  'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-hover',
                  e.id === selected?.id && 'bg-active',
                )}
              >
                <span className="mt-0.5 w-5 shrink-0 text-center">
                  {e.icon ? <EntryIcon icon={e.icon} /> : <FileText size={16} />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{e.name}</span>
                  <span className="block text-xs text-muted">{e.description}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
              <span className="flex-1 truncate text-sm text-muted">
                {selected ? 'Preview' : ''}
              </span>
              {selected?.saved && (
                <Button
                  onClick={() => store && deleteSavedTemplate(store, selected.id)}
                  aria-label="Delete template"
                >
                  <Trash2 size={14} />
                </Button>
              )}
              <Button
                variant="primary"
                disabled={!preview || busy}
                onClick={() => void use()}
                className="disabled:opacity-50"
              >
                Use template
              </Button>
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto px-8 py-6"
              data-testid="template-preview"
            >
              {preview && <BundlePreview key={selected!.id} bundle={preview} />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EntryIcon({ icon }: { icon: string }) {
  const { platform } = useApp();
  return <PageIcon icon={icon} size={16} fileUrl={platform.fileUrl} />;
}

/** A read-only look at a template: its top page, and its databases as tables. */
function BundlePreview({ bundle }: { bundle: PageBundle }) {
  const { platform } = useApp();
  const docs = useMemo(() => {
    const map = new Map<string, Y.Doc>();
    for (const [id, state] of Object.entries(bundle.docs)) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      map.set(id, doc);
    }
    return map;
  }, [bundle]);
  useEffect(() => () => docs.forEach((d) => d.destroy()), [docs]);
  const root = bundle.pages.find((p) => p.id === bundle.root)!;
  const base = useEditorServices(bundle.root);
  const pages = useMemo(() => new Map(bundle.pages.map((p) => [p.id, p])), [bundle]);
  // Relations show the titles of the template's own rows.
  const related = useMemo(() => {
    const map = new Map<string, RelatedPage>();
    for (const page of bundle.pages) {
      const doc = docs.get(page.id);
      if (page.kind !== 'database' || !doc) continue;
      for (const row of readDatabase(doc).rows) {
        map.set(row.id, { id: row.id, title: row.title, icon: row.icon, databaseId: page.id });
      }
    }
    return map;
  }, [bundle, docs]);
  const services = useMemo<EditorServices>(
    () => ({
      ...base,
      getPage: (id) => {
        const page = pages.get(id);
        if (!page) return base.getPage(id);
        return {
          id,
          title: page.title,
          icon: page.icon,
          inTrash: false,
          isDatabase: page.kind === 'database',
        };
      },
      navigate: () => {},
      renderDatabase: (id) => {
        const doc = docs.get(id);
        return doc ? (
          <DatabasePreview title={pages.get(id)?.title ?? ''} doc={doc} related={related} />
        ) : null;
      },
    }),
    [base, pages, docs, related],
  );

  return (
    <div className="mx-auto max-w-[720px]">
      <div className="mb-4 flex items-center gap-3">
        {root.icon && <PageIcon icon={root.icon} size={36} fileUrl={platform.fileUrl} />}
        <h2 className="text-3xl font-bold" data-testid="template-preview-title">
          {root.title || 'Untitled'}
        </h2>
      </div>
      {root.kind === 'database' ? (
        docs.get(root.id) && <DatabasePreview title="" doc={docs.get(root.id)!} related={related} />
      ) : (
        <PageEditor
          doc={docs.get(root.id) ?? new Y.Doc()}
          services={services}
          editable={false}
          nested
        />
      )}
    </div>
  );
}

const PREVIEW_ROWS = 8;

function DatabasePreview({
  title,
  doc,
  related,
}: {
  title: string;
  doc: Y.Doc;
  related: ReadonlyMap<string, RelatedPage>;
}) {
  const snapshot = useMemo(() => readDatabase(doc), [doc]);
  const view = snapshot.views[0];
  const byId = new Map(snapshot.properties.map((p) => [p.id, p]));
  const columns = view
    ? viewColumns(view, snapshot.properties)
        .filter((c) => c.visible)
        .map((c) => byId.get(c.id)!)
    : snapshot.properties;
  const rows = snapshot.rows.filter(isLiveRow);
  const ctx = { users: new Map<string, string>(), pages: related };
  return (
    <div className="my-2" data-testid="template-database">
      {title && <div className="mb-1 text-lg font-semibold">{title}</div>}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {columns.map((p) => (
                <th
                  key={p.id}
                  className="border-y border-line px-2 py-1 text-left font-normal whitespace-nowrap text-muted"
                >
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, PREVIEW_ROWS).map((row) => (
              <tr key={row.id}>
                {columns.map((p) => (
                  <td
                    key={p.id}
                    className="max-w-56 truncate border-b border-line px-2 py-1 whitespace-nowrap"
                  >
                    {cellText(row, p, ctx)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > PREVIEW_ROWS && (
        <p className="mt-1 text-xs text-faint">{rows.length - PREVIEW_ROWS} more</p>
      )}
    </div>
  );
}

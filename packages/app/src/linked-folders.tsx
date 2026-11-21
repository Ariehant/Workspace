/**
 * Settings → Linked folders (Phase 8 N9): the workspace's folder names, and where each is on
 * this computer. A page's linked file points inside one by name, so it opens on any computer
 * that links a folder under that name (the same synced folder, or a copy of it).
 */
import {
  addLinkedFolder,
  linkedFolderNameProblem,
  listLinkedFolders,
  observeLinkedFolders,
  removeLinkedFolder,
  workspaceDataDoc,
  type LinkedFolder,
} from '@workspace/core';
import { Button } from '@workspace/ui';
import { FolderPlus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useApp } from './context';
import type { Platform } from './platform';

/** The workspace's linked folders, kept current. */
export function useLinkedFolders(): LinkedFolder[] {
  const { workspace } = useApp();
  const doc = workspaceDataDoc(workspace);
  const subscribe = useCallback(
    (listener: () => void) => observeLinkedFolders(doc, listener),
    [doc],
  );
  const key = useSyncExternalStore(subscribe, () => JSON.stringify(listLinkedFolders(doc)));
  return useMemo(() => JSON.parse(key) as LinkedFolder[], [key]);
}

export function LinkedFoldersPanel({ linked }: { linked: NonNullable<Platform['linkedFiles']> }) {
  const { workspace, user } = useApp();
  const doc = workspaceDataDoc(workspace);
  const folders = useLinkedFolders();
  const [here, setHere] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const problem = name ? linkedFolderNameProblem(doc, name) : null;

  const reload = () => void linked.folders().then(setHere);
  useEffect(() => {
    void linked.folders().then(setHere);
  }, [linked]);

  const choose = async (folder: string) => {
    setError(null);
    try {
      const path = await linked.chooseFolder(folder);
      if (path) reload();
      return path;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The folder couldn’t be linked');
      return null;
    }
  };

  const add = async () => {
    if (!name || problem) return;
    // Where it is here first: a name nobody can open isn't much use.
    const path = await choose(name);
    if (!path) return;
    try {
      addLinkedFolder(doc, name, user.id);
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The folder couldn’t be added');
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="linked-folders">
      <p className="text-muted">
        Link files in a page without copying them in (<kbd>/linked file</kbd>). Files in a linked
        folder open on every computer that links a folder under the same name, such as one kept in
        sync with Dropbox, Syncthing or git. Other files open only on the computer they were linked
        on.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className="text-xs text-muted">Folder name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Projects"
            aria-invalid={!!problem}
            aria-describedby="linked-folder-problem"
            className="h-8 rounded-md border border-line bg-transparent px-2 outline-none focus:border-accent"
          />
        </label>
        <Button type="submit" variant="primary" disabled={!name || !!problem}>
          <FolderPlus size={14} aria-hidden /> Add and choose the folder…
        </Button>
      </form>
      {(problem ?? error) && (
        <p id="linked-folder-problem" role="alert" className="text-xs text-danger">
          {problem ?? error}
        </p>
      )}
      {folders.length === 0 ? (
        <p className="text-faint">No linked folders yet.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Linked folders">
          {folders.map((folder) => {
            const path = here[folder.name];
            return (
              <li
                key={folder.name}
                className="flex min-h-12 items-center gap-3 rounded-md px-2 py-1 hover:bg-hover"
                data-testid="linked-folder"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{folder.name}</span>
                  <span className="truncate text-xs text-muted" data-testid="linked-folder-path">
                    {path ?? 'Not linked on this computer'}
                  </span>
                </span>
                <Button variant="ghost" onClick={() => void choose(folder.name)}>
                  {path ? 'Change…' : 'Choose folder…'}
                </Button>
                {path && (
                  <Button
                    variant="ghost"
                    onClick={() => void linked.forgetFolder(folder.name).then(reload)}
                  >
                    Unlink here
                  </Button>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${folder.name} from the workspace`}
                  title="Remove from the workspace"
                  onClick={() => {
                    removeLinkedFolder(doc, folder.name);
                    void linked.forgetFolder(folder.name).then(reload);
                  }}
                  className="flex size-7 items-center justify-center rounded text-muted hover:bg-active"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

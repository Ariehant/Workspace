import {
  createPage,
  getMathMacros,
  listCustomEmoji,
  observeCustomEmoji,
  listUsers,
  observeMathMacros,
  setMathMacros,
  trashPage,
  type PageId,
  workspaceDataDoc,
} from '@workspace/core';
import { fillFromTable, tableCells } from '@workspace/database';
import type { EditorServices } from '@workspace/editor';
import { lazy, Suspense, useMemo } from 'react';
import { useApp } from './context';
import { InlineDatabase } from './database/database-view';
import { createDatabase } from './database/registry';
import { useNavigation } from './navigation';
import { observePeople, readPeople } from './people';
import { editButton } from './buttons/button-dialog';
import { runButton } from './buttons/run-button';
import { setDrivePickProblem } from './connections';
import { openSettings } from './settings/open';

/** Loaded when a preview is first opened (it brings the document readers). */
const FilePreview = lazy(() => import('./file-preview'));

/** What the editor of page (or row) `pageId` needs from the app. */
export function useEditorServices(
  pageId: PageId,
  rowProperties?: EditorServices['rowProperties'],
): EditorServices {
  const { workspace, platform, client, pages, databases, user, members, team } = useApp();
  const { navigate, openRow } = useNavigation();
  return useMemo(
    () => ({
      pageId,
      rowProperties,
      getPage: (id) => pages.get(id),
      // In a server workspace, a page that isn't here is mostly one this person can't see
      // (a getter: the trees can change after this is made).
      get missingPage() {
        return workspace.list().some((t) => t.info.kind !== 'local') ? 'No access' : undefined;
      },
      listPages: () => pages.list(),
      getBreadcrumb: () => pages.breadcrumb(pageId),
      navigate,
      createSubpage: () =>
        createPage(workspace, { parentId: pages.hostOf(pageId), createdBy: user.id }),
      createDatabase: () =>
        createDatabase(client, workspace, { parentId: pages.hostOf(pageId), createdBy: user.id }),
      renderDatabase: (id) => <InlineDatabase databaseId={id} />,
      renderLinkedDatabase: (id, viewSet) => <InlineDatabase databaseId={id} viewSet={viewSet} />,
      syncedPlaces: (id) => platform.syncedPlaces(id),
      acquireDoc: (id) => {
        const handle = client.acquire(id);
        return { ready: handle.ready.then(() => handle.doc), release: () => handle.release() };
      },
      runButton: (config, hooks) =>
        runButton(config, {
          app: { databases, workspace, user, pages, team, platform },
          pageId,
          navigate,
          openRow: (rowId, databaseId) => openRow(rowId, databaseId, 'sidePeek'),
          insertBlocks: hooks.insertBlocks,
        }),
      editButton: (config, buttonId) =>
        editButton({ config, mode: 'block', buttonId, hostPageId: pageId }),
      tableToDatabase: async (cells, header) => {
        const id = await createDatabase(client, workspace, {
          parentId: pages.hostOf(pageId),
          createdBy: user.id,
        });
        const handle = await databases.load(id);
        fillFromTable(handle.doc, cells, { header, actor: user.id });
        return id;
      },
      databaseToTable: async (id) => {
        const handle = await databases.load(id);
        const users = new Map(listUsers(workspaceDataDoc(workspace)).map((u) => [u.id, u.name]));
        const cells = tableCells(handle.doc, handle.snapshot().views[0]?.id ?? '', { users });
        trashPage(workspace, id);
        return cells;
      },
      subscribe: (listener) => pages.subscribe(listener),
      people: {
        me: user.id,
        list: () => {
          const people = readPeople(workspaceDataDoc(workspace), members);
          return people.active.map((id) => ({
            id,
            name: people.names.get(id) ?? '',
            avatar: people.avatars.get(id) ?? null,
          }));
        },
        get: (id) => {
          const people = readPeople(workspaceDataDoc(workspace), members);
          const name = people.names.get(id);
          return name === undefined ? null : { id, name, avatar: people.avatars.get(id) ?? null };
        },
        subscribe: (listener) => observePeople(workspaceDataDoc(workspace), members, listener),
      },
      uploadFile: (file) => platform.importFile(file),
      fileUrl: (id) => platform.fileUrl(id),
      openFile: (id) => platform.openFile(id),
      linkPreview: (url) => platform.linkPreview(url),
      drive: platform.google && {
        pick: async () => {
          const result = await platform.google!.pick();
          if ('ok' in result) return result.ok;
          // Not connected (or no Picker key): Settings says what's missing.
          setDrivePickProblem(
            result.error === 'notConnected'
              ? 'Connect Google Drive to link its files.'
              : result.error,
          );
          openSettings('connections');
          return [];
        },
        status: (fileId) => platform.google!.status(fileId),
        open: (fileId) => platform.google!.open(fileId),
        setUp: () => openSettings('connections'),
        subscribe: (listener) => platform.google!.onChange(listener),
        thumbnailUrl: platform.google.thumbnailUrl,
      },
      renderFilePreview: (source) => (
        <Suspense fallback={<p className="text-sm text-muted">Opening the preview…</p>}>
          <FilePreview {...source} />
        </Suspense>
      ),
      linkedFiles: platform.linkedFiles && {
        pick: () => platform.linkedFiles!.pick(false),
        locate: async () => (await platform.linkedFiles!.pick(true))[0] ?? null,
        status: (ref) => platform.linkedFiles!.status(ref),
        open: (ref) => platform.linkedFiles!.open(ref),
        reveal: (ref) => platform.linkedFiles!.reveal(ref),
        previewUrl: (ref) => platform.linkedFiles!.previewUrl(ref),
        setUpFolders: () => openSettings('linkedFolders'),
      },
      customEmoji: {
        list: () => listCustomEmoji(workspaceDataDoc(workspace)),
        subscribe: (listener) => observeCustomEmoji(workspaceDataDoc(workspace), listener),
      },
      mathMacros: {
        get: () => getMathMacros(workspaceDataDoc(workspace)),
        set: (macros) => setMathMacros(workspaceDataDoc(workspace), macros),
        subscribe: (listener) => observeMathMacros(workspaceDataDoc(workspace), listener),
      },
    }),
    [
      workspace,
      platform,
      client,
      pages,
      databases,
      user,
      members,
      team,
      pageId,
      navigate,
      openRow,
      rowProperties,
    ],
  );
}

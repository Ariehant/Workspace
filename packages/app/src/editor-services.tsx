import {
  createPage,
  getMathMacros,
  listUsers,
  observeMathMacros,
  setMathMacros,
  trashPage,
  type PageId,
  workspaceDataDoc,
} from '@workspace/core';
import { fillFromTable, tableCells } from '@workspace/database';
import type { EditorServices } from '@workspace/editor';
import { useMemo } from 'react';
import { useApp } from './context';
import { InlineDatabase } from './database/database-view';
import { createDatabase } from './database/registry';
import { useNavigation } from './navigation';
import { observePeople, readPeople } from './people';
import { editButton } from './buttons/button-dialog';
import { runButton } from './buttons/run-button';

/** What the editor of page (or row) `pageId` needs from the app. */
export function useEditorServices(pageId: PageId): EditorServices {
  const { workspace, platform, client, pages, databases, user, members, team } = useApp();
  const { navigate, openRow } = useNavigation();
  return useMemo(
    () => ({
      pageId,
      getPage: (id) => pages.get(id),
      // In a server workspace, a page that isn't here is mostly one this person can't see
      // (a getter: the trees can change after this is made).
      get missingPage() {
        return workspace.list().some((t) => t.info.kind !== 'local') ? 'No access' : undefined;
      },
      listPages: () => pages.list(),
      getBreadcrumb: () => pages.breadcrumb(pageId),
      navigate,
      createSubpage: () => createPage(workspace, { parentId: pages.hostOf(pageId) }),
      createDatabase: () => createDatabase(client, workspace, { parentId: pages.hostOf(pageId) }),
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
        const id = await createDatabase(client, workspace, { parentId: pages.hostOf(pageId) });
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
      mathMacros: {
        get: () => getMathMacros(workspaceDataDoc(workspace)),
        set: (macros) => setMathMacros(workspaceDataDoc(workspace), macros),
        subscribe: (listener) => observeMathMacros(workspaceDataDoc(workspace), listener),
      },
    }),
    [workspace, platform, client, pages, databases, user, members, team, pageId, navigate, openRow],
  );
}

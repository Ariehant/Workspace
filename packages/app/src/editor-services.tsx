import {
  createPage,
  getMathMacros,
  listUsers,
  observeMathMacros,
  setMathMacros,
  trashPage,
  type PageId,
} from '@workspace/core';
import { fillFromTable, tableCells } from '@workspace/database';
import type { EditorServices } from '@workspace/editor';
import { useMemo } from 'react';
import { useApp } from './context';
import { InlineDatabase } from './database/database-view';
import { createDatabase } from './database/registry';
import { useNavigation } from './navigation';
import { editButton } from './buttons/button-dialog';
import { runButton } from './buttons/run-button';

/** What the editor of page (or row) `pageId` needs from the app. */
export function useEditorServices(pageId: PageId): EditorServices {
  const { workspace, platform, client, pages, databases, user } = useApp();
  const { navigate, openRow } = useNavigation();
  return useMemo(
    () => ({
      pageId,
      getPage: (id) => pages.get(id),
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
          app: { databases, workspace, user, pages },
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
        const users = new Map(listUsers(workspace).map((u) => [u.id, u.name]));
        const cells = tableCells(handle.doc, handle.snapshot().views[0]?.id ?? '', { users });
        trashPage(workspace, id);
        return cells;
      },
      subscribe: (listener) => pages.subscribe(listener),
      uploadFile: (file) => platform.importFile(file),
      fileUrl: (id) => platform.fileUrl(id),
      openFile: (id) => platform.openFile(id),
      linkPreview: (url) => platform.linkPreview(url),
      mathMacros: {
        get: () => getMathMacros(workspace),
        set: (macros) => setMathMacros(workspace, macros),
        subscribe: (listener) => observeMathMacros(workspace, listener),
      },
    }),
    [workspace, platform, client, pages, databases, user, pageId, navigate, openRow],
  );
}

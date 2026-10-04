import { createPage, type PageId } from '@workspace/core';
import type { EditorServices } from '@workspace/editor';
import { useMemo } from 'react';
import { useApp } from './context';
import { InlineDatabase } from './database/database-view';
import { createDatabase } from './database/registry';
import { useNavigation } from './navigation';

/** What the editor of page (or row) `pageId` needs from the app. */
export function useEditorServices(pageId: PageId): EditorServices {
  const { workspace, platform, client, pages } = useApp();
  const { navigate } = useNavigation();
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
      subscribe: (listener) => pages.subscribe(listener),
      uploadFile: (file) => platform.importFile(file),
      fileUrl: (id) => platform.fileUrl(id),
      openFile: (id) => platform.openFile(id),
      linkPreview: (url) => platform.linkPreview(url),
    }),
    [workspace, platform, client, pages, pageId, navigate],
  );
}

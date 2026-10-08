import { listUsers, type ButtonConfig, workspaceDataDoc } from '@workspace/core';
import { readDatabase, runDatabaseStep } from '@workspace/database';
import type { AppContextValue } from '../context';

export interface ButtonEnv {
  app: Pick<AppContextValue, 'databases' | 'workspace' | 'user' | 'pages'>;
  navigate(id: string): void;
  openRow(rowId: string, databaseId: string): void;
  /** Button blocks: put the template blocks in the page. */
  insertBlocks?: (placement: 'above' | 'below') => Promise<void>;
  /** Database button property: the row it was clicked in. */
  row?: { databaseId: string; rowId: string };
  /** Ask the person (defaults to the browser's confirm dialog). */
  confirm?: (message: string) => boolean | Promise<boolean>;
}

/** Load a database and the databases its relations point at (two-way writes touch both). */
async function loadWithRelated(app: ButtonEnv['app'], databaseId: string): Promise<boolean> {
  if (!app.databases.exists(databaseId)) return false;
  const handle = await app.databases.load(databaseId);
  const targets = readDatabase(handle.doc)
    .properties.filter((p) => p.type === 'relation')
    .map((p) => p.config.databaseId ?? '')
    .filter((id) => app.databases.exists(id));
  await Promise.all(targets.map((id) => app.databases.load(id)));
  return true;
}

/** Run a button's steps in order; a declined confirmation stops the rest. */
export async function runButton(config: ButtonConfig, env: ButtonEnv): Promise<void> {
  const { app } = env;
  const users = new Map(listUsers(workspaceDataDoc(app.workspace)).map((u) => [u.id, u.name]));
  for (const step of config.steps) {
    switch (step.kind) {
      case 'confirm': {
        const ok = await (env.confirm ?? ((m: string) => window.confirm(m)))(
          step.message || 'Continue?',
        );
        if (!ok) return;
        break;
      }
      case 'insertBlocks':
        await env.insertBlocks?.(step.placement);
        break;
      case 'openPage': {
        const databaseId = app.pages.databaseOf(step.pageId);
        if (databaseId) env.openRow(step.pageId, databaseId);
        else env.navigate(step.pageId);
        break;
      }
      case 'addPage':
      case 'editPages':
      case 'editThisRow': {
        const databaseId = step.kind === 'editThisRow' ? env.row?.databaseId : step.databaseId;
        if (!databaseId || !(await loadWithRelated(app, databaseId))) break;
        const added = runDatabaseStep(step, {
          resolve: app.databases.resolveDoc,
          actor: app.user.id,
          ctx: { users, me: app.user.id },
          row: env.row,
        });
        if (step.kind === 'addPage' && step.open && added) env.openRow(added, databaseId);
        break;
      }
    }
  }
}

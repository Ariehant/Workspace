import { listUsers, type ButtonConfig, workspaceDataDoc } from '@workspace/core';
import { pageJson, readDatabase, runDatabaseStep } from '@workspace/database';
import type { AppContextValue } from '../context';

export interface ButtonEnv {
  app: Pick<AppContextValue, 'databases' | 'workspace' | 'user' | 'pages' | 'team' | 'platform'>;
  /** Button blocks: the page the button is in. */
  pageId?: string;
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

/**
 * Where a button is: the doc it lives in (its page, or a button property's database),
 * and the page it's about (that page, or the row).
 */
function place(env: ButtonEnv): { docId: string; pageId: string | null } | null {
  if (env.row) return { docId: env.row.databaseId, pageId: env.row.rowId };
  return env.pageId ? { docId: env.pageId, pageId: env.pageId } : null;
}

/** What a webhook says about the page: a row's title and properties, a page's title. */
async function pageData(env: ButtonEnv): Promise<unknown> {
  const { app } = env;
  if (env.row) {
    const handle = await app.databases.load(env.row.databaseId);
    const db = readDatabase(handle.doc);
    const row = db.rows.find((r) => r.id === env.row!.rowId);
    return row ? pageJson(row, db.properties) : null;
  }
  if (!env.pageId) return null;
  return { id: env.pageId, title: app.pages.get(env.pageId)?.title ?? '' };
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
      case 'webhook': {
        const where = place(env);
        if (!step.url || !where) break;
        const data = await pageData(env);
        const send = app.team
          ? app.team.buttonWebhook({
              ...where,
              url: step.url,
              headers: step.headers,
              data,
              label: config.label,
            })
          : app.platform.automations?.buttonWebhook({
              url: step.url,
              headers: step.headers,
              body: {
                source: { type: 'button', pageId: where.pageId, userId: app.user.id },
                data,
                triggeredAt: new Date().toISOString(),
              },
              label: config.label,
            });
        // A webhook that can't be sent doesn't stop the rest (the server tells them later).
        await Promise.resolve(send).catch((e: unknown) => console.error('Button webhook', e));
        break;
      }
      case 'notify': {
        const where = place(env);
        if (!where || step.people.length === 0) break;
        const send = app.team
          ? app.team.buttonNotify({
              ...where,
              people: step.people,
              message: step.message,
              label: config.label,
            })
          : app.platform.automations?.buttonNotify({
              title: `Button: ${config.label || 'Button'}`,
              body: step.message || config.label,
              pageId: where.pageId,
            });
        await Promise.resolve(send).catch((e: unknown) => console.error('Button notification', e));
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

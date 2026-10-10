/**
 * Phase 6 exit check: published open-source tools built on the official SDK run against
 * the server unchanged.
 *
 * - `@tryfabric/martian` turns Markdown into Notion blocks (as Markdown importers do);
 *   the SDK creates a page with them.
 * - `notion-to-md` reads the page back as Markdown (as Markdown exporters and static site
 *   generators do), walking its blocks and their children through the SDK.
 *
 * What comes out is what went in: the same Markdown, as `notion-to-md` writes it (lists
 * without blank lines between them, emphasis with `_`, padded tables). martian sends a
 * quote as an empty quote with the text as its child paragraph, and notion-to-md writes
 * that back as such.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@notionhq/client';
import { markdownToBlocks } from '@tryfabric/martian';
import { createPage } from '@workspace/core';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { NotionToMarkdown } from 'notion-to-md';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-real-world-'));
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (done: () => boolean, what: string, ms = 15_000) => {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const LAB = '0e1f2a3b-0000-4000-8000-0000000000cc';

const MARKDOWN = `# Arm design

The arm reaches **60 cm** and carries *2 kg*, see [the lab](https://lab.io) and \`reach_cm\`.

## Checks

- [x] Torque at full reach
- [ ] Cable routing

1. Mount the base
2. Fit the shoulder

- Servo
- Gear
    - Spur
    - Worm

> Keep it light.

\`\`\`python
reach_cm = 60
\`\`\`

| Part | Qty |
| --- | --- |
| Servo | 4 |
| Gear | 12 |
`;

/** A connected page and a token, on a real server. */
async function world() {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 6 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'open',
    PUBLIC_URL: 'http://app.test',
  });
  const app = buildServer({
    config,
    store,
    files: new FsStorage(dir),
    mailer: null,
    api: { perSecond: 1000, burst: 1000 },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: string, url: string, token: string, payload?: object): Promise<any> =>
    (
      await app.inject({
        method: method as 'GET',
        url,
        payload,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
  const signup = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    headers: { 'x-workspace-client': 'test' },
    payload: { email: 'ada@lab.io', name: 'Ada', password: 'long password', client: 'desktop' },
  });
  const token = signup.json().token as string;
  const ws = (await call('POST', '/api/workspaces', token, { name: 'Lab' })).workspace.id as string;
  const T = (await call('GET', `/api/workspaces/${ws}/scopes`, token)).defaultScopeId as string;
  const a = new TestDevice({ url: `ws://127.0.0.1:${port}/api/sync/${ws}`, token, deviceId: 'a' });
  cleanups.push(() => a.client.stop());
  a.client.start();
  await until(() => a.client.state.state === 'live', 'live');
  createPage(a.doc('workspace'), { id: LAB, title: 'Lab' });
  await until(() => a.outbox.length === 0, 'outbox sent');
  const made = await call('POST', `/api/workspaces/${ws}/integrations`, token, { name: 'Tools' });
  const scope = (
    await call('POST', `/api/workspaces/${ws}/pages/${LAB}/share`, token, { scope: T })
  ).scope;
  await call('PUT', `/api/workspaces/${ws}/scopes/${scope.id}/access`, token, {
    principal: `user:${made.integration.id}`,
    role: 'edit',
  });
  return new Client({ auth: made.token, baseUrl: `http://127.0.0.1:${port}`, retry: false });
}

describe('published Notion tools, unchanged', () => {
  it('Markdown in with martian, back out with notion-to-md: the same document', async () => {
    const notion = await world();
    const blocks = markdownToBlocks(MARKDOWN);
    const page = await notion.pages.create({
      parent: { page_id: LAB },
      properties: { title: { title: [{ text: { content: 'Arm design' } }] } },
      // martian's blocks are typed for its own copy of the SDK.
      children: blocks as Parameters<typeof notion.pages.create>[0]['children'],
    });
    // (notion-to-md is typed against its own copy of the SDK: the client is the same API.)
    type N2MClient = ConstructorParameters<typeof NotionToMarkdown>[0]['notionClient'];
    const n2m = new NotionToMarkdown({ notionClient: notion as unknown as N2MClient });
    const markdown = n2m.toMarkdownString(await n2m.pageToMarkdown(page.id)).parent;
    expect(markdown?.trim()).toBe(EXPECTED.trim());
  });
});

const EXPECTED = `# Arm design


The arm reaches **60 cm** and carries _2 kg_, see [the lab](https://lab.io) and \`reach_cm\`.


## Checks

- [x] Torque at full reach
- [ ] Cable routing
1. Mount the base
2. Fit the shoulder
- Servo
- Gear
    - Spur
    - Worm
> 
>
> Keep it light.
>
>

\`\`\`python
reach_cm = 60
\`\`\`


| Part  | Qty |
| ----- | --- |
| Servo | 4   |
| Gear  | 12  |`;

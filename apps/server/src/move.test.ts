/**
 * Moving a page to another workspace (Phase 8 #31): real server and Postgres. Ada has
 * "Lab" (with Bob, a member, and Gus, a guest) and "Home". Her page in Lab, with a sub-page,
 * a database and an attachment, moves to her private pages in Home.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPage, getPage, getPageContent, isInTrash, listPages } from '@workspace/core';
import {
  addProperty,
  addRow,
  createRelation,
  initDatabase,
  readDatabase,
  relationIds,
  setRelation,
} from '@workspace/database';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as Y from 'yjs';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { fileCandidates } from './move-routes';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-move-'));
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEklEQVR4nGP4z8AARwzEcQwDAH2gC/UmQhvLAAAAAElFTkSuQmCC',
  'base64',
);
const FILE_ID = `${createHash('sha256').update(PNG).digest('hex')}.png`;

async function world() {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 8 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'open',
    PUBLIC_URL: 'http://app.test',
  });
  const app = buildServer({ config, store, files: new FsStorage(dir), mailer: null });
  await app.ready();
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );
  const call = async (method: string, url: string, token: string, payload?: object) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  };
  const signup = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'x-workspace-client': 'test' },
      payload: { email: `${name}@lab.io`, name, password: 'long password', client: 'desktop' },
    });
    return { token: res.json().token as string, id: res.json().user.id as string };
  };
  const [ada, bob, gus] = [await signup('ada'), await signup('bob'), await signup('gus')];
  const workspace = async (name: string) =>
    (await call('POST', '/api/workspaces', ada.token, { name })).body.workspace.id as string;
  const lab = await workspace('Lab');
  const home = await workspace('Home');
  const join = async (ws: string, person: typeof bob, name: string, role: string) => {
    const invite = await call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
      emails: [`${name}@lab.io`],
      role,
    });
    const token = (invite.body.invites[0].link as string).split('/invite/')[1];
    expect((await call('POST', `/api/invites/${token}/accept`, person.token)).status).toBe(200);
  };
  await join(lab, bob, 'bob', 'member');
  await join(home, bob, 'bob', 'member');
  await join(home, gus, 'gus', 'guest');
  await join(lab, gus, 'gus', 'member');

  const doc = async (ws: string, id: string) => {
    const d = new Y.Doc();
    const state = await store.docState(ws, id);
    if (state) Y.applyUpdate(d, state);
    return d;
  };
  /** Write to docs as the server does (as Ada). */
  const edit = (ws: string, id: string, change: (d: Y.Doc) => void, scope?: string) =>
    app.docs.edit(ws, id, { userId: ada.id }, change, { scope: scope ?? null });
  const scopes = async (ws: string, token = ada.token) =>
    (await call('GET', `/api/workspaces/${ws}/scopes`, token)).body.scopes as {
      id: string;
      kind: string;
      treeDoc: string;
    }[];
  return { app, store, call, ada, bob, gus, lab, home, doc, edit, scopes };
}

describe('moving a page to another workspace', () => {
  it('takes its sub-pages, database, rows and attachments; the original goes to the trash', async () => {
    const w = await world();
    const { call, ada, lab, home } = w;
    const teamspace = (await w.scopes(lab)).find((s) => s.kind === 'teamspace')!;

    // In Lab: "Gripper" (text, an attachment), its sub-page "Notes", and "Parts", a
    // database whose rows link to each other.
    const upload = await w.app.inject({
      method: 'PUT',
      url: `/api/workspaces/${lab}/files/${FILE_ID}`,
      payload: PNG,
      headers: {
        authorization: `Bearer ${ada.token}`,
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent('drawing.png'),
        'x-file-mime': 'image/png',
      },
    });
    expect(upload.statusCode).toBeLessThan(300);
    let gripper = '';
    let notes = '';
    let parts = '';
    await w.edit(lab, teamspace.treeDoc, (tree) => {
      gripper = createPage(tree, { title: 'Gripper', icon: '🦾', createdBy: ada.id });
      notes = createPage(tree, { title: 'Notes', parentId: gripper, createdBy: ada.id });
      parts = createPage(tree, {
        title: 'Parts',
        kind: 'database',
        parentId: gripper,
        createdBy: ada.id,
      });
    });
    await w.edit(
      lab,
      gripper,
      (d) => {
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText('Two fingers, one servo.')]);
        const image = new Y.XmlElement('image');
        image.setAttribute('fileId', FILE_ID);
        getPageContent(d).insert(0, [p, image]);
      },
      teamspace.id,
    );
    let servo = '';
    let bracket = '';
    let uses = '';
    await w.edit(
      lab,
      parts,
      (d) => {
        initDatabase(d, { databaseId: parts });
        addProperty(d, { name: 'Drawing', type: 'files' });
        servo = addRow(d, { actor: ada.id, title: 'Servo' });
        bracket = addRow(d, { actor: ada.id, title: 'Bracket' });
        uses = createRelation((id) => (id === parts ? d : undefined), {
          databaseId: parts,
          name: 'Uses',
          targetId: parts,
        }).propertyId;
        setRelation((id) => (id === parts ? d : undefined), parts, servo, uses, [bracket], ada.id);
      },
      teamspace.id,
    );

    // Where it can go: her other workspaces.
    const targets = await call('GET', `/api/workspaces/${lab}/move-targets`, ada.token);
    expect(targets.body.workspaces).toEqual([{ id: home, name: 'Home' }]);

    const moved = await call(
      'POST',
      `/api/workspaces/${lab}/pages/${gripper}/move-to-workspace`,
      ada.token,
      {
        to: home,
      },
    );
    expect(moved.status).toBe(200);
    expect(moved.body.workspaceId).toBe(home);
    const copy = moved.body.pageId as string;
    expect(copy).not.toBe(gripper);

    // In Home: her private pages, with everything under it (new ids).
    const mine = (await w.scopes(home)).find((s) => s.kind === 'private')!;
    const tree = await w.doc(home, mine.treeDoc);
    expect(getPage(tree, copy)).toMatchObject({ title: 'Gripper', icon: '🦾', parentId: null });
    const children = listPages(tree).filter((p) => p.parentId === copy);
    expect(children.map((p) => p.title).sort()).toEqual(['Notes', 'Parts']);
    const copiedParts = children.find((p) => p.title === 'Parts')!;
    expect(copiedParts.kind).toBe('database');
    const content = await w.doc(home, copy);
    expect(getPageContent(content).toString()).toContain('Two fingers, one servo.');
    expect(getPageContent(content).toString()).toContain(FILE_ID);
    const db = readDatabase(await w.doc(home, copiedParts.id));
    const rows = db.rows.filter((r) => !r.isTemplate);
    expect(rows.map((r) => r.title).sort()).toEqual(['Bracket', 'Servo']);
    const [copiedServo, copiedBracket] = ['Servo', 'Bracket'].map((t) =>
      rows.find((r) => r.title === t)!,
    );
    // The relation links the copies (not the originals).
    expect(copiedServo!.id).not.toBe(servo);
    expect(relationIds(copiedServo!.values[uses])).toEqual([copiedBracket!.id]);
    // The attachment is there too.
    const file = await w.app.inject({
      method: 'GET',
      url: `/api/workspaces/${home}/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${ada.token}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);

    // In Lab: in the trash (with its sub-pages), not deleted.
    const labTree = await w.doc(lab, teamspace.treeDoc);
    expect(isInTrash(labTree, gripper)).toBe(true);
    expect(isInTrash(labTree, notes)).toBe(true);
    // In the trash, it can't be moved again.
    expect(
      (
        await call('POST', `/api/workspaces/${lab}/pages/${gripper}/move-to-workspace`, ada.token, {
          to: home,
        })
      ).status,
    ).toBe(404);
  });

  it('needs full access here, and a member (not a guest) there', async () => {
    const w = await world();
    const { call, ada, bob, gus, lab, home } = w;
    const teamspace = (await w.scopes(lab)).find((s) => s.kind === 'teamspace')!;
    let page = '';
    await w.edit(lab, teamspace.treeDoc, (tree) => {
      page = createPage(tree, { title: 'Budget', createdBy: ada.id });
    });
    const move = (token: string, to: string) =>
      call('POST', `/api/workspaces/${lab}/pages/${page}/move-to-workspace`, token, { to });

    // Bob may edit the teamspace, not share it (he's in Home too): no.
    const byBob = await move(bob.token, home);
    expect(byBob.status).toBe(403);
    expect(byBob.body.message).toBe('Moving a page needs full access to it.');
    // Gus is only a guest in Home (and can't see it as a target).
    expect((await call('GET', `/api/workspaces/${lab}/move-targets`, gus.token)).body).toEqual({
      workspaces: [],
    });
    // The same workspace, or one she isn't in.
    expect((await move(ada.token, lab)).status).toBe(400);
    expect((await move(ada.token, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    // A page that isn't there.
    expect(
      (
        await call('POST', `/api/workspaces/${lab}/pages/nope/move-to-workspace`, ada.token, {
          to: home,
        })
      ).status,
    ).toBe(404);
    // Nothing moved.
    expect(isInTrash(await w.doc(lab, teamspace.treeDoc), page)).toBe(false);
  });

  it('finds the attachments an encoded doc names, whatever follows them', () => {
    const hash = 'a'.repeat(64);
    const doc = new Y.Doc();
    doc.getMap('m').set('file', `${hash}.png`);
    doc.getMap('m').set('next', 'z');
    const found = fileCandidates({
      root: 'p',
      pages: [],
      docs: { p: Y.encodeStateAsUpdate(doc) },
    });
    expect(found.has(`${hash}.png`)).toBe(true);
    expect(found.has(hash)).toBe(true);
  });
});

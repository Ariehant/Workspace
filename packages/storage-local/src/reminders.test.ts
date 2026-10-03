import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_DOC_ID,
  createPage,
  getPageContent,
  reminderTime,
  trashPage,
} from '@workspace/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { DocManager, SqliteStore } from './index';

let dir: string;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-reminders-'));
  store = new SqliteStore(join(dir, 'workspace.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A window editing a doc through the manager (as in storage.test.ts). */
function connect(manager: DocManager, docId: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, manager.open(docId), 'load');
  doc.on(
    'update',
    (u: Uint8Array, origin: unknown) => origin !== 'load' && manager.applyUpdate(docId, u, 'w1'),
  );
  return doc;
}

let nextBlock = 0;
function addReminder(page: Y.Doc, date: string, text: string) {
  const p = new Y.XmlElement('paragraph');
  p.setAttribute('id', `block-${nextBlock++}`);
  const mention = new Y.XmlElement('mention');
  mention.setAttribute('kind', 'date');
  mention.setAttribute('date', date);
  mention.setAttribute('reminder', true as unknown as string);
  p.insert(0, [new Y.XmlText(`${text} `), mention]);
  getPageContent(page).push([p]);
}

describe('reminders', () => {
  it('are indexed from page content, become due at 9:00, and fire once', () => {
    const changed = vi.fn();
    const manager = new DocManager(store, { onRemindersChanged: changed });
    const ws = connect(manager, WORKSPACE_DOC_ID);
    const id = createPage(ws, { title: 'Build log' });
    const page = connect(manager, id);
    addReminder(page, '2026-10-05', 'Order servos');
    manager.flush();
    expect(changed).toHaveBeenCalled();

    const at = reminderTime('2026-10-05')!;
    expect(store.nextReminderAt()).toBe(at);
    expect(store.dueReminders(at - 1)).toEqual([]);
    const [due] = store.dueReminders(at);
    expect(due).toMatchObject({
      pageId: id,
      pageTitle: 'Build log',
      fireAt: at,
      text: 'Order servos',
    });

    store.markReminderFired(due!);
    expect(store.dueReminders(at)).toEqual([]);
    // Editing the text around a fired reminder doesn't re-arm it.
    const first = getPageContent(page).get(0) as Y.XmlElement;
    (first.get(0) as Y.XmlText).insert(0, 'Urgent: ');
    manager.flush();
    expect(store.dueReminders(at)).toEqual([]);
    // Editing the page re-indexes it without re-arming the fired reminder.
    addReminder(page, '2026-10-06', 'Test drive');
    manager.flush();
    expect(store.dueReminders(reminderTime('2026-10-06')!).map((r) => r.text)).toEqual([
      'Test drive',
    ]);
    manager.close();
  });

  it('skip pages in the trash and disappear with deleted pages', () => {
    const manager = new DocManager(store);
    const ws = connect(manager, WORKSPACE_DOC_ID);
    const id = createPage(ws, { title: 'Old' });
    addReminder(connect(manager, id), '2026-01-01', 'stale');
    manager.flush();
    const far = reminderTime('2030-01-01')!;
    expect(store.dueReminders(far)).toHaveLength(1);

    trashPage(ws, id);
    manager.flush();
    expect(store.dueReminders(far)).toEqual([]);
    manager.close();
  });
});

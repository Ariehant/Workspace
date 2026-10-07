import { basename, extname } from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { DocManager } from '@workspace/storage-local';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC, type ImportStatus } from '../shared/ipc';
import type { ImportJob, ImportWorkerMessage } from './import-worker';
import createImportWorker from './import-worker?nodeWorker';

/** Origin of the updates an import applies (not a window's edit). */
export const IMPORT_ORIGIN = 'import';

/**
 * Imports: pick files (a Notion export zip, Markdown, HTML, CSV or text), build the pages
 * in a worker, then apply them here. One at a time, cancellable until it's applied.
 */
export function registerImport(deps: {
  manager: DocManager;
  dbPath: string;
  dataDir: string;
  /** Attachments were added (the worker stores them directly). */
  onFiles: () => void;
}): void {
  let running: Worker | null = null;

  ipcMain.handle(IPC.importStart, async (event) => {
    if (running) throw new Error('An import is already running');
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Import',
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [
        {
          name: 'Notion export, Markdown, HTML, CSV or text',
          extensions: ['zip', 'md', 'markdown', 'html', 'htm', 'csv', 'txt'],
        },
      ],
    };
    const { canceled, filePaths } = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (canceled || filePaths.length === 0) return false;

    const sender = event.sender;
    const send = (status: ImportStatus) => {
      if (!sender.isDestroyed()) sender.send(IPC.importStatus, status);
    };
    const first = filePaths[0]!;
    const title = filePaths.length === 1 ? basename(first, extname(first)) || 'Import' : 'Import';
    const job: ImportJob = { dbPath: deps.dbPath, dataDir: deps.dataDir, paths: filePaths, title };
    const worker = createImportWorker({ workerData: job });
    running = worker;
    let settled = false;
    const settle = (status: ImportStatus) => {
      if (settled) return;
      settled = true;
      running = null;
      void worker.terminate();
      send(status);
    };
    send({ state: 'running', done: 0, total: 0 });
    worker.on('message', (message: ImportWorkerMessage) => {
      if (settled) return;
      if (message.type === 'progress') send({ state: 'running', ...message });
      else if (message.type === 'error') settle({ state: 'failed', error: message.error });
      else if (message.type === 'docs') {
        try {
          for (const { id, update } of message.docs) {
            deps.manager.applyUpdate(id, update, IMPORT_ORIGIN);
          }
          settle({ state: 'done', report: message.report });
          if (message.report.files > 0) deps.onFiles();
        } catch (error) {
          settle({
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    worker.on('error', (error) => settle({ state: 'failed', error: error.message }));
    worker.on('exit', (code) => {
      if (code !== 0) settle({ state: 'failed', error: `Import stopped (exit code ${code})` });
    });
    return true;
  });

  ipcMain.on(IPC.importCancel, () => {
    if (!running) return;
    const worker = running;
    running = null;
    void worker.terminate();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.importStatus, { state: 'cancelled' });
    }
  });
}

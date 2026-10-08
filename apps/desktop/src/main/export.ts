import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { getPage } from '@workspace/core';
import type { DocManager } from '@workspace/storage-local';
import { BrowserWindow, app, dialog, ipcMain, type WebContents } from 'electron';
import { IPC, type ExportFormat, type ExportRequest, type ExportStatus } from '../shared/ipc';
import type { ExportJob, WorkerMessage } from './export-worker';
import createExportWorker from './export-worker?nodeWorker';

const FORMATS: readonly ExportFormat[] = ['markdown', 'html', 'pdf', 'backup'];
const PRINT_TIMEOUT_MS = 60_000;
const MERMAID_TIMEOUT_MS = 60_000;

function isRequest(value: unknown): value is ExportRequest {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<ExportRequest>;
  if (!FORMATS.includes(r.format as ExportFormat)) return false;
  if (r.pageId !== undefined && (typeof r.pageId !== 'string' || r.pageId.length > 128))
    return false;
  if (r.format === 'pdf') {
    const pdf = r.pdf;
    if (!r.pageId || !pdf || !['A4', 'Letter'].includes(pdf.pageSize)) return false;
    if (typeof pdf.scale !== 'number' || pdf.scale < 0.1 || pdf.scale > 2) return false;
  }
  return true;
}

const fileSafe = (name: string) =>
  name
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Untitled';

export interface ExportDeps {
  manager: DocManager;
  dbPath: string;
  filesDir: string;
  /** A hidden window showing a page for printing (`hash` like `print=<id>`). */
  createPrintWindow(hash: string): BrowserWindow;
  /** Replace the workspace with a backup (closes everything and restarts). */
  restore(path: string): void;
}

/**
 * Exports: Markdown/CSV and HTML zips and backups run in a worker thread; PDFs print a
 * hidden window. One at a time, with progress sent to the window that asked, and
 * cancellable.
 */
export function registerExport(deps: ExportDeps): void {
  let running: { cancel(): void } | null = null;

  const defaultName = (request: ExportRequest): string => {
    const date = new Date().toISOString().slice(0, 10);
    if (request.format === 'backup') return `Workspace backup ${date}.zip`;
    const title = request.pageId
      ? (getPage(deps.manager.forest, request.pageId)?.title ?? 'Untitled')
      : 'Workspace';
    const kind = request.format === 'html' ? 'HTML' : request.format === 'pdf' ? '' : 'Markdown';
    return `${fileSafe(title || 'Untitled')}${kind ? ` (${kind})` : ''}.${request.format === 'pdf' ? 'pdf' : 'zip'}`;
  };

  ipcMain.handle(IPC.exportStart, async (event, request: unknown) => {
    if (!isRequest(request)) throw new Error('Invalid export request');
    if (running) throw new Error('An export is already running');
    const window = BrowserWindow.fromWebContents(event.sender);
    const pdf = request.format === 'pdf';
    const options = {
      defaultPath: join(app.getPath('downloads'), defaultName(request)),
      filters: [pdf ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Zip', extensions: ['zip'] }],
    };
    const { canceled, filePath } = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return false;

    const sender = event.sender;
    const send = (status: ExportStatus) => {
      if (!sender.isDestroyed()) sender.send(IPC.exportStatus, status);
    };
    const finish = (status: ExportStatus) => {
      running = null;
      if (status.state !== 'done') rmSync(filePath, { force: true });
      send(status);
    };
    send({ state: 'running', done: 0, total: 0 });
    if (pdf) printPdf(request, filePath, send, finish);
    else runWorker(request, filePath, sender, send, finish);
    return true;
  });

  ipcMain.on(IPC.exportCancel, () => running?.cancel());

  ipcMain.handle(IPC.backupRestore, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Restore from backup',
      properties: ['openFile' as const],
      filters: [{ name: 'Workspace backup', extensions: ['zip'] }],
    };
    const { canceled, filePaths } = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (canceled || !filePaths[0]) return false;
    const confirm = {
      type: 'warning' as const,
      message: 'Replace this workspace with the backup?',
      detail:
        'The current workspace is moved aside (kept in the data folder), the backup is restored, and the app restarts.',
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    };
    const { response } = window
      ? await dialog.showMessageBox(window, confirm)
      : await dialog.showMessageBox(confirm);
    if (response !== 0) return false;
    deps.restore(filePaths[0]);
    return true;
  });

  function runWorker(
    request: ExportRequest,
    outPath: string,
    sender: WebContents,
    send: (status: ExportStatus) => void,
    finish: (status: ExportStatus) => void,
  ) {
    const job: ExportJob = {
      dbPath: deps.dbPath,
      filesDir: deps.filesDir,
      outPath,
      kind: request.format === 'backup' ? 'backup' : 'pages',
      options:
        request.format === 'backup'
          ? undefined
          : {
              format: request.format === 'html' ? 'html' : 'markdown',
              roots: request.pageId ? [request.pageId] : 'all',
              includeSubpages: request.pageId ? Boolean(request.includeSubpages) : true,
            },
    };
    const worker: Worker = createExportWorker({ workerData: job });
    let settled = false;
    const settle = (status: ExportStatus) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      finish(status);
    };
    running = { cancel: () => settle({ state: 'cancelled' }) };
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'progress') send({ state: 'running', ...message });
      else if (message.type === 'done') settle({ state: 'done', path: outPath });
      else if (message.type === 'error') settle({ state: 'failed', error: message.error });
      else if (message.type === 'mermaid') {
        // The renderer draws the diagrams (Mermaid needs a DOM); answer with whatever
        // comes back, or nothing after a while.
        const reply = (svgs: Record<string, string>) => {
          clearTimeout(timer);
          ipcMain.removeListener(IPC.exportMermaidResult, onResult);
          if (!settled) worker.postMessage({ type: 'mermaid', svgs });
        };
        const onResult = (event: Electron.IpcMainEvent, svgs: unknown) => {
          if (event.sender !== sender) return;
          reply(svgs && typeof svgs === 'object' ? (svgs as Record<string, string>) : {});
        };
        const timer = setTimeout(() => reply({}), MERMAID_TIMEOUT_MS);
        ipcMain.on(IPC.exportMermaidResult, onResult);
        if (sender.isDestroyed()) reply({});
        else sender.send(IPC.exportMermaid, message.sources);
      }
    });
    worker.on('error', (error) => settle({ state: 'failed', error: error.message }));
    worker.on('exit', (code) => {
      if (code !== 0) settle({ state: 'failed', error: `Export stopped (exit code ${code})` });
    });
  }

  function printPdf(
    request: ExportRequest,
    outPath: string,
    send: (status: ExportStatus) => void,
    finish: (status: ExportStatus) => void,
  ) {
    const params = new URLSearchParams({ print: request.pageId! });
    if (request.includeSubpages) params.set('subpages', '1');
    const window = deps.createPrintWindow(params.toString());
    let settled = false;
    const settle = (status: ExportStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener(IPC.printReady, onReady);
      if (!window.isDestroyed()) window.destroy();
      finish(status);
    };
    running = { cancel: () => settle({ state: 'cancelled' }) };
    const timer = setTimeout(
      () => settle({ state: 'failed', error: 'The page took too long to render' }),
      PRINT_TIMEOUT_MS,
    );
    const onReady = (event: Electron.IpcMainEvent) => {
      if (window.isDestroyed() || event.sender !== window.webContents) return;
      send({ state: 'running', done: 1, total: 2 });
      window.webContents
        .printToPDF({
          pageSize: request.pdf!.pageSize,
          scale: request.pdf!.scale,
          printBackground: true,
        })
        .then((data) => {
          if (settled) return;
          writeFileSync(outPath, data);
          settle({ state: 'done', path: outPath });
        })
        .catch((error: unknown) =>
          settle({
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    };
    ipcMain.on(IPC.printReady, onReady);
    window.on('closed', () => settle({ state: 'cancelled' }));
  }
}

/** Where a restore moves the current workspace: a dated folder inside the data dir. */
export function asideDir(dataDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dir = join(dataDir, `before-restore-${stamp}`);
  for (let n = 2; existsSync(dir); n++) dir = join(dataDir, `before-restore-${stamp}-${n}`);
  return dir;
}

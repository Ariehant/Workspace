import { clampZoom, stepZoom } from '@workspace/core';
import type { SqliteStore } from '@workspace/storage-local';
import { ipcMain, type BrowserWindow as Window, type Input } from 'electron';
import { IPC } from '../shared/ipc';

const SETTING = 'ui.zoom';
/** Chromium reports one Ctrl+wheel notch as two `zoom-changed` events. */
const WHEEL_GAP_MS = 40;

export interface Zoom {
  /** Zoom this window with the others, and follow the keyboard and Ctrl+wheel. */
  attach(window: Window): void;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
}

/** What a key press does to the zoom, if anything: Ctrl with =/+, - or 0 (or the keypad's). */
function zoomKey(input: Input): 'in' | 'out' | 'reset' | null {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null;
  switch (input.code) {
    case 'Equal':
    case 'NumpadAdd':
      return 'in';
    case 'Minus':
    case 'NumpadSubtract':
      return 'out';
    case 'Digit0':
    case 'Numpad0':
      return input.shift ? null : 'reset';
  }
  // Layouts where + is its own key.
  if (input.key === '+') return 'in';
  return null;
}

/**
 * The app's zoom: one level for every window (kept in the settings), changed with
 * Ctrl+= / Ctrl+- / Ctrl+0, Ctrl+wheel, the View menu or the Appearance menu.
 */
export function createZoom(store: SqliteStore): Zoom {
  let factor = clampZoom(store.getSetting<number>(SETTING) ?? 1);
  const windows = new Set<Window>();

  const set = (next: number) => {
    next = clampZoom(next);
    if (next === factor) return;
    factor = next;
    store.setSetting(SETTING, factor);
    for (const window of windows) {
      if (window.isDestroyed()) continue;
      window.webContents.setZoomFactor(factor);
      window.webContents.send(IPC.zoomChanged, factor);
    }
  };
  const zoomIn = () => set(stepZoom(factor, 'in'));
  const zoomOut = () => set(stepZoom(factor, 'out'));
  const reset = () => set(1);

  ipcMain.handle(IPC.zoomGet, () => factor);
  ipcMain.on(IPC.zoomSet, (_event, next: unknown) => {
    if (typeof next === 'number') set(next);
  });

  return {
    attach(window) {
      windows.add(window);
      window.on('closed', () => windows.delete(window));
      const contents = window.webContents;
      contents.on('did-finish-load', () => contents.setZoomFactor(factor));
      contents.on('before-input-event', (event, input) => {
        const key = zoomKey(input);
        if (!key) return;
        event.preventDefault();
        if (key === 'in') zoomIn();
        else if (key === 'out') zoomOut();
        else reset();
      });
      let lastWheel = 0;
      contents.on('zoom-changed', (_event, direction) => {
        const now = Date.now();
        if (now - lastWheel < WHEEL_GAP_MS) return;
        lastWheel = now;
        if (direction === 'in') zoomIn();
        else zoomOut();
      });
    },
    zoomIn,
    zoomOut,
    reset,
  };
}

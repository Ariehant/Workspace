import { writeFileSync } from 'node:fs';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, quit, test } from './helpers';

/** The zoom of each of the app's windows, as Electron has it. */
const factors = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => Math.round(w.webContents.getZoomFactor() * 100)),
  );

/**
 * Keys and the wheel as the system sends them (Playwright's go straight to the page, past
 * the main process, which handles the zoom keys); to the focused window.
 */
const send = (app: ElectronApplication, events: Electron.InputEvent[]) =>
  app.evaluate(({ BrowserWindow }, events) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]!;
    for (const event of events) window.webContents.sendInputEvent(event as never);
  }, events);
const key = (app: ElectronApplication, keyCode: string) =>
  send(app, [
    { type: 'keyDown', keyCode, modifiers: ['control'] } as Electron.KeyboardInputEvent,
    { type: 'keyUp', keyCode, modifiers: ['control'] } as Electron.KeyboardInputEvent,
  ]);
const wheel = (app: ElectronApplication, deltaY: number) =>
  send(app, [
    {
      type: 'mouseWheel',
      x: 600,
      y: 400,
      deltaY,
      wheelTicksY: Math.sign(deltaY),
      canScroll: true,
      modifiers: ['control'],
    } as Electron.MouseWheelInputEvent,
  ]);

/** A screenshot from Electron (Playwright's crops a zoomed page to its unzoomed size). */
async function capture(app: ElectronApplication, path: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]!;
    return (await window.webContents.capturePage()).toPNG().toString('base64');
  });
  writeFileSync(path, Buffer.from(png, 'base64'));
}

/** The level the Appearance menu shows (it closes again after). */
async function shownLevel(window: Page): Promise<string | null> {
  await window.getByRole('button', { name: 'Appearance' }).click();
  const level = await window.getByTestId('zoom-level').textContent();
  await window.keyboard.press('Escape');
  return level;
}

test('zoom with the keyboard, Ctrl+wheel and the Appearance menu, in every window, kept', async ({
  launch,
}, testInfo) => {
  const launched = await launch();
  const { app } = launched;
  let { window } = launched;
  expect(await factors(app)).toEqual([100]);

  // Ctrl+= (not just Ctrl+Plus), Ctrl+-, Ctrl+0.
  await key(app, '=');
  await expect.poll(() => factors(app)).toEqual([110]);
  expect(await window.evaluate(() => globalThis.devicePixelRatio)).toBeCloseTo(1.1, 2);
  expect(await shownLevel(window)).toBe('110%');
  await key(app, '-');
  await key(app, '-');
  await expect.poll(() => factors(app)).toEqual([90]);
  await key(app, '0');
  await expect.poll(() => factors(app)).toEqual([100]);

  // One Ctrl+wheel notch is one step.
  await wheel(app, 120);
  await expect.poll(() => factors(app)).toEqual([110]);
  await window.waitForTimeout(200);
  expect(await factors(app)).toEqual([110]);

  // The Appearance menu: the level, and zoom in and out without closing.
  await window.getByRole('button', { name: 'Appearance' }).click();
  await window.getByRole('menuitem', { name: /Zoom in/ }).click();
  await expect(window.getByTestId('zoom-level')).toHaveText('125%');
  // The menu stays on screen as it grows.
  await expect(window.getByRole('menuitem', { name: /Actual size/ })).toBeInViewport({ ratio: 1 });
  await capture(app, testInfo.outputPath('zoom-125.png'));
  await window.getByRole('menuitem', { name: /Zoom out/ }).click();
  await expect(window.getByTestId('zoom-level')).toHaveText('110%');
  await window.keyboard.press('Escape');
  expect(await factors(app)).toEqual([110]);

  // A new window opens at the same level, and a change reaches both.
  const opened = app.waitForEvent('window');
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.getMenuItemById('new-window')?.click(),
  );
  const second = await opened;
  await second.getByTestId('sidebar-page-title').first().waitFor();
  await expect.poll(() => factors(app)).toEqual([110, 110]);
  await second.bringToFront();
  await key(app, '=');
  await expect.poll(() => factors(app)).toEqual([125, 125]);
  expect(await shownLevel(window)).toBe('125%');
  await second.close();

  // Kept across a restart.
  await quit(app);
  const again = await launch();
  window = again.window;
  await expect.poll(() => factors(again.app)).toEqual([125]);
  expect(await shownLevel(window)).toBe('125%');

  // Smallest: everything still fits.
  for (let i = 0; i < 12; i++) await key(again.app, '-');
  await expect.poll(() => factors(again.app)).toEqual([50]);
  await expect.poll(() => window.evaluate(() => globalThis.devicePixelRatio)).toBeCloseTo(0.5, 2);
  await window.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));
  await capture(again.app, testInfo.outputPath('zoom-50.png'));
  await key(again.app, '0');
  await expect.poll(() => factors(again.app)).toEqual([100]);
});

import {
  BrowserWindow,
  Menu,
  app,
  type BaseWindow,
  type MenuItemConstructorOptions,
} from 'electron';
import { IPC } from '../shared/ipc';

export function buildMenu(createWindow: () => BrowserWindow, isDev: boolean): Menu {
  const send = (command: string) => (_item: unknown, window: BaseWindow | undefined) => {
    if (window instanceof BrowserWindow) window.webContents.send(IPC.command, command);
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: 'New Page', click: send('new-page') },
        // The renderer handles the tab shortcuts itself, so the menu only shows them.
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          registerAccelerator: false,
          click: send('new-tab'),
        },
        {
          id: 'new-window',
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow(),
        },
        { type: 'separator' },
        { label: 'Sync…', click: send('sync-settings') },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          registerAccelerator: false,
          click: send('close-tab'),
        },
        { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
        { role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Toggle Sidebar', click: send('toggle-sidebar') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev
          ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as const)
          : []),
      ],
    },
    {
      label: '&Go',
      // The renderer handles these shortcuts itself (they also work in the web build),
      // so the menu only shows them.
      submenu: [
        {
          label: 'Search…',
          accelerator: 'CmdOrCtrl+K',
          registerAccelerator: false,
          click: send('quick-find'),
        },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          registerAccelerator: false,
          click: send('go-back'),
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          registerAccelerator: false,
          click: send('go-forward'),
        },
        { type: 'separator' },
        {
          label: 'Next Tab',
          accelerator: 'Ctrl+Tab',
          registerAccelerator: false,
          click: send('next-tab'),
        },
        {
          label: 'Previous Tab',
          accelerator: 'Ctrl+Shift+Tab',
          registerAccelerator: false,
          click: send('prev-tab'),
        },
      ],
    },
    {
      label: '&Help',
      submenu: [{ label: `About ${app.getName()}`, role: 'about' }],
    },
  ];
  return Menu.buildFromTemplate(template);
}

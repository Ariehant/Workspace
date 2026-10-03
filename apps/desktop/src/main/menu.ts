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
        {
          id: 'new-window',
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow(),
        },
        { type: 'separator' },
        { role: 'close' },
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
      ],
    },
    {
      label: '&Help',
      submenu: [{ label: `About ${app.getName()}`, role: 'about' }],
    },
  ];
  return Menu.buildFromTemplate(template);
}

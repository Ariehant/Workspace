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
      label: '&Help',
      submenu: [{ label: `About ${app.getName()}`, role: 'about' }],
    },
  ];
  return Menu.buildFromTemplate(template);
}

import { App, type AppCommand, type Platform } from '@workspace/app';
import '@workspace/editor/editor.css';
import '@workspace/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const api = window.workspace;

const platform: Platform = {
  transport: {
    open: api.docs.open,
    push: api.docs.push,
    close: api.docs.close,
    subscribe: api.docs.onUpdate,
  },
  getSetting: api.settings.get,
  setSetting: api.settings.set,
  setTheme: api.setTheme,
  onCommand: (listener) => api.onCommand((command) => listener(command as AppCommand)),
  onNavigate: (listener) => api.onNavigate(listener),
  ready: api.ready,
  importFile: async (file) =>
    api.files.import(new Uint8Array(await file.arrayBuffer()), file.name, file.type),
  fileUrl: (id) => `ws-file://${id}`,
  openFile: (id) => void api.files.open(id),
  linkPreview: (url) => api.linkPreview(url),
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App platform={platform} />
  </StrictMode>,
);

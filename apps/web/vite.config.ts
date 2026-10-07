import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { EMBED_PROVIDERS } from '../../packages/editor/src/nodes/embeds';

const EMBED_ORIGINS = EMBED_PROVIDERS.map((provider) => provider.origin);

/** Strict CSP for builds (the dev server needs inline scripts for HMR). */
const csp = (): Plugin => ({
  name: 'workspace-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https: http:",
          "media-src 'self' blob: https:",
          // PDFs (attachments, same origin) and embeds.
          `frame-src 'self' ${EMBED_ORIGINS.join(' ')}`,
          "font-src 'self' data:",
          // The API and the sync socket, on this origin ('self' covers ws/wss in CSP3).
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'self'",
        ].join('; '),
      },
      injectTo: 'head-prepend',
    },
  ],
});

export default defineConfig({
  plugins: [react(), tailwindcss(), csp()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // `pnpm dev` against a local server: VITE_SERVER=http://127.0.0.1:3000 pnpm dev
    proxy: process.env.VITE_SERVER
      ? { '/api': { target: process.env.VITE_SERVER, ws: true, changeOrigin: false } }
      : undefined,
  },
});

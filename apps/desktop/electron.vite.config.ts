import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { EMBED_PROVIDERS } from '../../packages/editor/src/nodes/embeds';

// Origins the embed block may load, from the editor's provider list (single source).
const EMBED_ORIGINS = EMBED_PROVIDERS.map((provider) => provider.origin);

/** Strict CSP for production builds (the dev server needs inline scripts for HMR). */
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
          "img-src 'self' data: blob: https: http: ws-file:",
          "media-src 'self' blob: https: ws-file:",
          // PDFs (ws-file:) and embeds.
          `frame-src ws-file: ${EMBED_ORIGINS.join(' ')}`,
          "font-src 'self' data:",
          "connect-src 'self' ws-file:",
          "object-src 'none'",
          "base-uri 'none'",
        ].join('; '),
      },
      injectTo: 'head-prepend',
    },
  ],
});

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: [
          'node:sqlite',
          // The import worker uses the editor's schema, never its Mermaid preview: keep that out.
          'mermaid',
          // ws's optional native helpers: left as real (failing) requires, so ws falls back
          // to its JavaScript versions. Bundled, they'd become empty objects and break it.
          'bufferutil',
          'utf-8-validate',
        ],
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads must be a single CommonJS file.
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss(), csp()],
    build: { minify: !process.env.WORKSPACE_NO_MINIFY },
  },
});

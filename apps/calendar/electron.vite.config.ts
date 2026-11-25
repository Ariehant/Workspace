import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Strict CSP for production builds (the dev server needs inline scripts for HMR). The
 * renderer makes no network requests: everything goes through the main process.
 */
const csp = (): Plugin => ({
  name: 'calendar-csp',
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
          "img-src 'self' data:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; '),
      },
      injectTo: 'head-prepend',
    },
  ],
});

export default defineConfig({
  main: {
    build: { rollupOptions: { external: ['node:sqlite'] } },
  },
  preload: {
    build: {
      // Sandboxed preloads must be a single CommonJS file.
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss(), csp()],
    // electron-vite doesn't minify by default.
    build: { minify: true },
  },
});

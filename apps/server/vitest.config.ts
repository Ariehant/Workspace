import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../../packages/storage-remote/src/test-setup.ts'],
    setupFiles: ['../../vitest.setup.ts'],
    testTimeout: 20_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test-setup.ts'],
    // Each file gets its own database, so files can run in parallel.
    testTimeout: 20_000,
  },
});

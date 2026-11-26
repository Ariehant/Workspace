import { defineConfig } from 'vitest/config';

// Unit tests of the main process's pure code (the E2E suite is in e2e/, run by Playwright).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});

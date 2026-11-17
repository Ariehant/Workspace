import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Unit tests only (`e2e/` is Playwright's).
  test: { include: ['src/**/*.test.ts'], setupFiles: ['../../vitest.setup.ts'] },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The integration tests start a real Workspace server (a build and a Postgres).
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

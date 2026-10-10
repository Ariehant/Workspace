import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.bench.test.ts'],
    // One at a time, so the timings don't compete for the CPU.
    fileParallelism: false,
    testTimeout: 300_000,
  },
});

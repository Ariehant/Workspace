import { defineConfig } from 'vitest/config';

// The benchmarks (`*.bench.test.ts`) take minutes: they run with `pnpm bench`, not `pnpm test`.
export default defineConfig({
  test: { exclude: ['**/node_modules/**', 'src/**/*.bench.test.ts'] },
});

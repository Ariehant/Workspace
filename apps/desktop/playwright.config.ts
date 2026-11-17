import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // A step that can't happen fails with what it waited for (not a bare test timeout).
  use: { trace: 'retain-on-failure', actionTimeout: 30_000 },
});

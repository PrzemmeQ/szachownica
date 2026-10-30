import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120000,
  workers: 1,
  reporter: 'list',
  use: { ...devices['Pixel 7'], trace: 'retain-on-failure', actionTimeout: 15000 },
});

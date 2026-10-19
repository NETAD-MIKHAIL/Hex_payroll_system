import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5273', headless: true, screenshot: 'only-on-failure' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5273',
    reuseExistingServer: true,
    timeout: 180000,
  },
  reporter: 'list',
});

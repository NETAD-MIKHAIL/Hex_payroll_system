import { defineConfig } from '@playwright/test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const requireApi = createRequire(new URL('../api/package.json', import.meta.url));
requireApi('dotenv').config({
  path: fileURLToPath(new URL('../api/.env.test', import.meta.url)),
  quiet: true,
});
// Live browser tests use the same dedicated fixture guards as API regression.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SYNC_MODE = 'disabled';
export default defineConfig({
  testDir: './test',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5273', headless: true, screenshot: 'only-on-failure' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5273',
    reuseExistingServer: true,
    timeout: 60000,
  },
  reporter: 'list',
});

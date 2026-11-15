import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    },
  },
  webServer: [
    {
      command: 'npm run preview -- --port 4173 --strictPort',
      port: 4173,
      reuseExistingServer: true,
    },
    {
      // dist/ as GitHub Pages serves it: no isolation headers (pages.spec.ts).
      command: 'node e2e/pages-server.mjs 4174',
      port: 4174,
      reuseExistingServer: true,
    },
  ],
});

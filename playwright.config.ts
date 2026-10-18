import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testMatch: 'e2e/*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
  },
});

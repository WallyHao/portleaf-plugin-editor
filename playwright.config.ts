import { defineConfig } from '@playwright/test';
const report = process.env.PORTLEAF_VALIDATION_LABEL || 'electron';
if (!/^[a-z][a-z0-9-]*$/.test(report)) throw new Error('Invalid Electron report label.');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: `test-results/${report}`,
  reporter: [
    ['list'],
    ['json', { outputFile: `test-results/${report}.json` }],
    ['html', { outputFolder: `playwright-report/${report}`, open: 'never' }],
  ],
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45_000,
  use: { trace: 'retain-on-failure' },
});

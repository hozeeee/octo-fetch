import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e', workers: 1, fullyParallel: false, timeout: 180000,
  expect: { timeout: 15000 }, reporter: 'list',
  use: { trace: 'off', screenshot: 'only-on-failure' }
})

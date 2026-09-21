const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  workers: 2,
  use: { baseURL: 'http://127.0.0.1:4173', channel: 'chrome', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' } }
  ],
  webServer: { command: 'node tests/server.cjs', url: 'http://127.0.0.1:4173', reuseExistingServer: true }
});

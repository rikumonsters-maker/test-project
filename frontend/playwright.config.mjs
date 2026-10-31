import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir:'./e2e', timeout:30000, retries:0, reporter:'list',
  use:{baseURL:'http://127.0.0.1:5517',browserName:'chromium',trace:'retain-on-failure'},
  webServer:{command:'node dev-server.mjs',url:'http://127.0.0.1:5517/',env:{PORT:'5517'},reuseExistingServer:false,timeout:15000},
  outputDir:'./test-results/e2e',
});

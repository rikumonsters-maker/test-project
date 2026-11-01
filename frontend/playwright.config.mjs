import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir:'./e2e', timeout:30000, retries:0, reporter:'list',
  use:{baseURL:'http://127.0.0.1:5517',browserName:'chromium',trace:'retain-on-failure'},
  webServer:[
    {command:'node dev-server.mjs',url:'http://127.0.0.1:5517/',env:{PORT:'5517'},reuseExistingServer:false,timeout:15000},
    {command:'node dev-server.mjs',url:'http://127.0.0.1:5500/',env:{PORT:'5500'},reuseExistingServer:false,timeout:15000},
    {command:'node e2e/start-local-worker.mjs',url:'http://127.0.0.1:8787/api/auth/me',reuseExistingServer:false,timeout:120000},
  ],
  outputDir:'./test-results/e2e',
});

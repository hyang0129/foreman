import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  timeout: 30000,
  expect: { timeout: 7000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4188",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e/serve.mjs",
    url: "http://127.0.0.1:4188",
    reuseExistingServer: false,
  },
});

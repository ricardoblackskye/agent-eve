import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const browserPath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(browserPath
          ? { launchOptions: { executablePath: browserPath } }
          : {}),
      },
    },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
    url: `${baseURL}/eve/v1/health`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});

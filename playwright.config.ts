import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100", ...devices["Pixel 7"], launchOptions: { executablePath: process.env.CHROMIUM_PATH } },
  reporter: "line",
});

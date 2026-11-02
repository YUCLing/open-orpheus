import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testMatch: "__test__/e2e/*.spec.ts",
  globalSetup: fileURLToPath(import.meta.resolve("./__test__/e2e/setup.ts")),
  globalTeardown: fileURLToPath(import.meta.resolve("./__test__/e2e/teardown.ts")),

  // The suite drives a real Electron app rendering the NCM web app, so give
  // startup and navigation room on slower machines.
  timeout: 120_000,
  expect: { timeout: 15_000 },
});

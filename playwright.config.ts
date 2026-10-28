import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testMatch: "__test__/e2e/*.spec.ts",
  globalSetup: fileURLToPath(import.meta.resolve("./__test__/e2e/setup.ts")),
  globalTeardown: fileURLToPath(import.meta.resolve("./__test__/e2e/teardown.ts")),
});

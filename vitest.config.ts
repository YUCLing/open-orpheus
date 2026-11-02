import { configDefaults, defineConfig } from "vitest/config";

import { createAliases } from "./scripts/tsconfigAliases.js";

export default defineConfig({
  resolve: {
    alias: createAliases(),
  },
  test: {
    // Keep unit tests from importing the real Electron package, which may
    // download a binary as a module side effect.
    setupFiles: ["__test__/helpers/setup.ts", "__test__/helpers/electron.ts"],
    exclude: [...configDefaults.exclude, "modules/*", "__test__/e2e/*"],
    coverage: {
      include: ["src/**/*.ts", "packaging/**/*.ts"],
      exclude: [
        "src/{preload,worklets}/**/*.ts",
        // Type-only declarations
        "src/shared/types/**/*.ts",
        // Constants
        "packaging/resources/metadata.ts",
        "packaging/common/toolchain.ts",
        "src/constants.ts",
      ],
    },
  },
});

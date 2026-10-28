import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      $sharedTypes: fileURLToPath(new URL("./types", import.meta.url)),
    },
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
        // Constants
        "packaging/resources/metadata.ts",
        "packaging/common/toolchain.ts",
        "src/constants.ts",
      ],
    },
  },
});

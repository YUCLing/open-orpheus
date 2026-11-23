import { configDefaults, defineConfig } from "vitest/config";

import RegistryPlugin from "./tools/forge/plugins/RegistryPlugin.js";
import RealmRuntimePlugin from "./tools/forge/plugins/RealmRuntimePlugin.js";
import { createAliases } from "./tools/shared/tsconfig.js";

export default defineConfig({
  plugins: [RegistryPlugin(), RealmRuntimePlugin()],
  resolve: {
    alias: createAliases(),
  },
  test: {
    // Keep unit tests from importing the real Electron package, which may
    // download a binary as a module side effect.
    setupFiles: ["__test__/helpers/setup.ts", "__test__/helpers/electron.ts"],
    exclude: [...configDefaults.exclude, "modules/*", "__test__/e2e/*"],
    coverage: {
      include: ["src/**/*.ts", "tools/packaging/**/*.ts"],
      exclude: [
        "src/{preload,worklets}/**/*.ts",
        // Type-only declarations
        "src/shared/types/**/*.ts",
        // Generated plugin artifacts
        "packages/plugin-api/dist/**",
        // Constants
        "tools/config/packaging.ts",
        "tools/config/toolchain.ts",
        "src/constants.ts",
      ],
    },
  },
});

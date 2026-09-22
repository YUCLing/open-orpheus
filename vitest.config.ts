import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@main": fileURLToPath(new URL("./src/main", import.meta.url)),
      "@preload": fileURLToPath(new URL("./src/preload", import.meta.url)),
      "@bridge": fileURLToPath(new URL("./src/bridge", import.meta.url)),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "modules/*"],
    coverage: {
      include: ["src/**/*.ts", "packaging/**/*.ts"],
      exclude: [
        "src/{preload,worklets}/**/*.ts",
        // Constants
        "packaging/options.ts",
        "packaging/common/toolchain.ts",
        "src/shared/constants.ts",
        // Declaration-only shared types would otherwise enter the denominator
        "src/shared/types/**",
      ],
    },
  },
});

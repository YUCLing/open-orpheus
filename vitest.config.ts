import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      $sharedTypes: fileURLToPath(new URL("./types", import.meta.url)),
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
        "src/constants.ts",
      ],
    },
  },
});

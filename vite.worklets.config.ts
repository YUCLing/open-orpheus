import { defineConfig } from "vite";

import { createAliases } from "./tools/shared/tsconfig.js";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: createAliases(),
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "worklets/[name].js",
        assetFileNames: "worklets/assets/[name][extname]",
      },
    },
  },
});

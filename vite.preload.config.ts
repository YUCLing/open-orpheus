import { defineConfig } from "vite";

import { createAliases } from "./scripts/tsconfigAliases.js";
import LoggerPlugin from "./plugins/LoggerPlugin.js";
import RegistryPlugin from "./plugins/RegistryPlugin.js";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: createAliases(),
  },
  plugins: [
    LoggerPlugin({
      logger: "src/preload/logger.ts",
    }),
    RegistryPlugin({ realm: "preload" }),
  ],
});

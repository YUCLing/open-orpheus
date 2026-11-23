import { defineConfig } from "vite";

import { createAliases } from "./tools/shared/tsconfig.js";
import LoggerPlugin from "./tools/forge/plugins/LoggerPlugin.js";
import RegistryPlugin from "./tools/forge/plugins/RegistryPlugin.js";
import RealmRuntimePlugin from "./tools/forge/plugins/RealmRuntimePlugin.js";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: createAliases(),
  },
  plugins: [
    LoggerPlugin({
      logger: "src/preload/logger.ts",
    }),
    RegistryPlugin(),
    RealmRuntimePlugin(),
  ],
});

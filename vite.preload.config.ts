import { defineConfig } from "vite";

import LoggerPlugin from "./build-plugins/LoggerPlugin.js";

// https://vitejs.dev/config
export default defineConfig({
  plugins: [
    LoggerPlugin({
      logger: "src/preload/logger.ts",
    }),
  ],
});

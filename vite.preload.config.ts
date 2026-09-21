import { defineConfig } from "vite";

import LoggerPlugin from "./build/vite-plugins/LoggerPlugin.js";

// https://vitejs.dev/config
export default defineConfig({
  plugins: [
    LoggerPlugin({
      logger: "src/preload/logger.ts",
    }),
  ],
});

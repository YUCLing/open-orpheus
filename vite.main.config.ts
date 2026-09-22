import { defineConfig } from "vite";

import PinoWorkerPlugin from "./build-plugins/PinoWorkerPlugin.js";
import NoS3Plugin from "./build-plugins/NoS3Plugin.js";
import LoggerPlugin from "./build-plugins/LoggerPlugin.js";
import ForceESPlugin from "./build-plugins/ForceESPlugin.js";

// https://vitejs.dev/config
export default defineConfig({
  base: "",
  build: {
    sourcemap: process.env.INLINE_SOURCEMAP ? "inline" : false,
    rolldownOptions: {
      external: [
        // Node built-ins
        "sqlite",
        // Keyv SQLite driver workarounds
        "better-sqlite3",
        // Native/WASM Modules
        "7z-wasm",
        "music-tag-native",
        "@silvia-odwyer/photon-node",
        "@open-orpheus/database",
        "@open-orpheus/window",
        "@open-orpheus/ui",
        "@open-orpheus/dbus",
        "@open-orpheus/smtc",
        "@open-orpheus/nowplaying",
      ],
    },
  },
  worker: {
    format: "es",
    rolldownOptions: {
      external: [/^node:/, "@open-orpheus/av3a"],
    },
  },
  // unzipper has a dependency on @aws-sdk/client-s3, which is not needed in
  // our context and causes build issues. This plugin mocks it out.
  plugins: [
    NoS3Plugin(),
    ForceESPlugin(),
    PinoWorkerPlugin(),
    LoggerPlugin({
      logger: "src/main/platform/logger.ts",
      // Child logger names stay relative to src/main even though the logger module
      // now lives in platform/, so no log record is renamed by the move.
      base: "src/main",
      // These are the modules registered into the pack's CallDispatcher, i.e. the ones
      // reachable through channel.call. Without this the per-command `call` loggers vanish.
      callModulesDir: "src/main/calls/handlers",
    }),
  ],
});

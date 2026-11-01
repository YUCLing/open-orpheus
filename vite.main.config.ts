import { defineConfig } from "vite";

import { createAliases } from "./scripts/tsconfigAliases.js";
import PinoWorkerPlugin from "./plugins/PinoWorkerPlugin.js";
import NoS3Plugin from "./plugins/NoS3Plugin.js";
import LoggerPlugin from "./plugins/LoggerPlugin.js";
import ForceESPlugin from "./plugins/ForceESPlugin.js";

// https://vitejs.dev/config
export default defineConfig({
  base: "",
  resolve: {
    alias: createAliases(),
  },
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
        "@open-orpheus/system-win32",
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
  plugins: [NoS3Plugin(), ForceESPlugin(), LoggerPlugin(), PinoWorkerPlugin()],
});

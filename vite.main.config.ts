import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import PinoWorkerPlugin from "./build-plugins/PinoWorkerPlugin.js";
import NoS3Plugin from "./build-plugins/NoS3Plugin.js";
import LoggerPlugin from "./build-plugins/LoggerPlugin.js";
import ForceESPlugin from "./build-plugins/ForceESPlugin.js";

// https://vitejs.dev/config
export default defineConfig({
  base: "",
  resolve: {
    alias: {
      $sharedTypes: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "types"
      ),
    },
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
  plugins: [NoS3Plugin(), ForceESPlugin(), PinoWorkerPlugin(), LoggerPlugin()],
});

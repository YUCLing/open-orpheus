import { defineConfig } from "vite";

import { createAliases } from "./tools/shared/tsconfig.js";
import PinoWorkerPlugin from "./tools/forge/plugins/PinoWorkerPlugin.js";
import NoS3Plugin from "./tools/forge/plugins/NoS3Plugin.js";
import LoggerPlugin from "./tools/forge/plugins/LoggerPlugin.js";
import ForceESPlugin from "./tools/forge/plugins/ForceESPlugin.js";
import RegistryPlugin from "./tools/forge/plugins/RegistryPlugin.js";
import RealmRuntimePlugin from "./tools/forge/plugins/RealmRuntimePlugin.js";
import BuiltinPluginsPlugin from "./tools/forge/plugins/BuiltinPluginsPlugin.js";

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
  plugins: [
    BuiltinPluginsPlugin(),
    NoS3Plugin(),
    ForceESPlugin(),
    LoggerPlugin(),
    PinoWorkerPlugin(),
    RegistryPlugin(),
    RealmRuntimePlugin(),
  ],
});

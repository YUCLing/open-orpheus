import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { "main/index": "src/index.ts" },
  outDir: "dist",
  format: ["esm"],
  fixedExtension: true,
  platform: "node",
  dts: false,
  clean: true,
  copy: ["metadata.json"],
  deps: {
    neverBundle: ["@open-orpheus/plugin-api"],
    // Keep the plugin self-contained: packaged apps prune dependencies that are
    // not declared by the host package, so the RPC client must be inlined.
    alwaysBundle: [/^@discordjs\/rpc$/, /^@vladfrangu\/async_event_emitter$/, /^discord-api-types/],
  },
});

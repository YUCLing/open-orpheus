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
  },
});

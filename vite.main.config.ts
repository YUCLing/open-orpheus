import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, Plugin } from "vite";

// unzipper has a dependency on @aws-sdk/client-s3, which is not needed in
// our context and causes build issues. This plugin mocks it out.
function NoS3Plugin() {
  return {
    name: "no-s3",
    resolveId(id: string) {
      if (id === "@aws-sdk/client-s3") {
        return id; // Mark as resolved but empty
      }
    },
    load(id: string) {
      if (id === "@aws-sdk/client-s3") {
        return "export default {}"; // Provide an empty module
      }
    },
  };
}

function PinoPlugin(): Plugin {
  const pino = path.dirname(require.resolve("pino"));
  const threadStream = path.dirname(require.resolve("thread-stream"));

  // Pino itself
  const entries: Record<string, string> = {
    "thread-stream-worker": path.join(threadStream, "lib/worker.js"),
    "pino-worker": path.join(pino, "lib/worker.js"),
    "pino/file": path.join(pino, "file.js"),
  };

  // Transports to inject
  ["pino-pretty"].forEach((v) => (entries[v] = require.resolve(v)));

  const references: Record<string, string> = {};

  return {
    name: "pino-bundler",
    buildStart() {
      for (const entry in entries) {
        const target = entries[entry];
        references[entry] = this.emitFile({
          type: "chunk",
          id: target,
          name: entry,
        });
      }
    },
    generateBundle(options, bundle) {
      let overrideCode = `{ const { resolve } = require("path"); globalThis.__bundlerPathsOverrides = {`;
      for (const entry in references) {
        overrideCode += JSON.stringify(entry);
        overrideCode += ":";
        overrideCode += `resolve(__dirname, ${JSON.stringify(this.getFileName(references[entry]))}),`;
      }
      overrideCode += "};console.log(globalThis.__bundlerPathsOverrides)}";
      const transportChunks = Object.keys(entries);
      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk.type === "chunk" && chunk.isEntry) {
          if (transportChunks.includes(chunk.name)) continue;
          chunk.code = `${overrideCode}${chunk.code}`;
        }
      }
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      $sharedTypes: path.resolve(fileURLToPath(import.meta.url), "types"),
    },
  },
  build: {
    rollupOptions: {
      external: [
        // Native/WASM Modules
        "7z-wasm",
        "music-tag-native",
        "@silvia-odwyer/photon-node",
        "@open-orpheus/database",
        "@open-orpheus/window",
        "@open-orpheus/ui",
      ],
    },
  },
  plugins: [NoS3Plugin(), PinoPlugin()],
});

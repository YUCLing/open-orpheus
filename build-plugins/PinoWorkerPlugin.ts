import { hash } from "node:crypto";
import path from "node:path";

import { normalizePath, Plugin } from "vite";

/**
 * Vite plugin that provides Pino worker path overrides
 */
export default function PinoWorkerPlugin(): Plugin {
  const pathsModuleId = "virtual:pino-bundler-path-overrides";
  const pathsModuleName = "pino-paths-overrides";

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

  for (const entry in entries) {
    entries[entry] = normalizePath(entries[entry]);
  }

  const transportChunkIds = Object.values(entries);
  const references: Record<string, string> = {};
  const placeholders: Record<string, string> = {};

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
      this.emitFile({
        type: "chunk",
        id: pathsModuleId,
        name: "pino-paths-overrides",
      });
    },
    resolveId(id) {
      if (id === pathsModuleId) return id;
    },
    load(id) {
      if (id === pathsModuleId) {
        let overrideCode = `globalThis.__bundlerPathsOverrides = {`;
        for (const entry in references) {
          const placeholder = (placeholders[entry] =
            "_OVRD_" + hash("md5", references[entry], "hex"));
          overrideCode += JSON.stringify(entry);
          overrideCode += ":";
          overrideCode += `resolve(import.meta.dirname, ${placeholder}),`;
        }
        overrideCode += "};";
        return `import { resolve } from "node:path";${overrideCode}`;
      }
    },
    transform(code, id) {
      if (transportChunkIds.includes(id)) return null;
      const moduleInfo = this.getModuleInfo(id);
      if (!moduleInfo || !moduleInfo.isEntry) return null;
      return `import ${JSON.stringify(pathsModuleId)}\n${code}`;
    },
    generateBundle(options, bundle) {
      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk.type === "chunk" && chunk.name === pathsModuleName) {
          for (const entry in references) {
            chunk.code = chunk.code.replace(
              placeholders[entry],
              JSON.stringify(this.getFileName(references[entry]))
            );
          }
        }
      }
    },
  };
}

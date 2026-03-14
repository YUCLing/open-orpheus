import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

const basePath = resolve(__dirname, "betterncm");

export default function BetterNCMPlugin(): import("vite").Plugin {
  return {
    name: "better-ncm",
    resolveId(id: string) {
      if (id === "better-ncm-framework") {
        return id;
      }
    },
    async load(id: string) {
      if (id !== "better-ncm-framework") {
        return null;
      }

      try {
        const betterNCM = {
          resources: {} as Record<string, string>,
        };
        await Promise.allSettled(
          [
            "framework.js",
            "framework.js.map",
            "framework.css",
            "framework.css.map",
          ].map(async (file) => {
            const filePath = resolve(basePath, file);
            const content = await readFile(filePath, "utf-8");
            betterNCM.resources[file] = content;
          })
        );
        return `export default ${JSON.stringify(betterNCM)}`;
      } catch {
        return `export default null`; // Return null if any file fails to load
      }
    },
  };
}

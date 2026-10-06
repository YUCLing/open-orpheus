import { defineConfig, type Plugin, type UserConfig } from "vite";
import { fork } from "node:child_process";
import { resolve } from "node:path";

const WRAPPER = resolve(import.meta.dirname, "scripts/gui-wrapper.ts");
// Port for the SvelteKit dev server spawned alongside the dummy Vite dev server.
const SVELTEKIT_DEV_PORT = 5174;

/**
 * Bridges Electron Forge's VitePlugin renderer lifecycle to the SvelteKit
 * project in `gui/`.
 */
function svelteKitPlugin(): Plugin {
  return {
    name: "sveltekit-bridge",

    config(_, { command }): UserConfig {
      if (command === "serve") {
        return {
          server: {
            proxy: {
              "/": {
                target: `http://localhost:${SVELTEKIT_DEV_PORT}`,
                changeOrigin: true,
                ws: true,
              },
            },
          },
        };
      }
      return {};
    },

    async configureServer() {
      const proc = fork(WRAPPER, ["dev"], {
        env: {
          DEV_PORT: String(SVELTEKIT_DEV_PORT),
        },
      });
      proc.stdout?.pipe(process.stdout);
      proc.stderr?.pipe(process.stderr);
      proc.on("error", (e) => {
        throw e;
      });
      proc.on("exit", (code) => {
        throw new Error(`Dev process exited with code ${code}`);
      });
      await new Promise<void>((resolve, reject) => {
        proc.on("message", (msg) => {
          if (msg === "READY") {
            resolve();
          } else {
            reject(msg);
          }
        });
      });
    },

    async buildStart() {
      if (!this.meta.watchMode) {
        await new Promise<void>((resolve, reject) => {
          const proc = fork(WRAPPER, ["build"]);
          proc.on("error", reject);
          proc.on("exit", reject);
          proc.on("message", (msg) => {
            if (msg === "DONE") {
              resolve();
            } else {
              reject(msg);
            }
          });
        });
      }
    },

    // Rollup requires at least one input entry; resolve this virtual module to
    // an empty module so the Rollup pass produces no real output of its own.
    resolveId(id) {
      if (id === "virtual:sveltekit-bridge") return "\0virtual:sveltekit-bridge";
    },
    load(id) {
      if (id === "\0virtual:sveltekit-bridge") return "export default {}";
    },

    generateBundle(_, bundle) {
      for (const key of Object.keys(bundle)) {
        if (
          (bundle[key] as { facadeModuleId?: string }).facadeModuleId ===
          "\0virtual:sveltekit-bridge"
        ) {
          delete bundle[key];
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [svelteKitPlugin()],
  build: {
    // SvelteKit writes its own output to .vite/build/gui via adapter-static.
    // Vite's own Rollup pass has nothing to bundle, so keep emptyOutDir off to
    // preserve what SvelteKit generated.
    emptyOutDir: false,
    rollupOptions: {
      input: { _sveltekit: "virtual:sveltekit-bridge" },
    },
  },
  server: {
    watch: null,
  },
});

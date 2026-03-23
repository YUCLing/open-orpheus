import { defineConfig, type Plugin, type UserConfig } from "vite";
import { spawnSync, spawn } from "node:child_process";
import { resolve } from "node:path";

const GUI_DIR = resolve(__dirname, "gui");
// Port for the SvelteKit dev server spawned alongside the dummy Vite dev server.
const SVELTEKIT_DEV_PORT = 5174;

function getPackageManagerCommand() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return { command: process.execPath, baseArgs: [npmExecPath] };
  }

  return { command: "pnpm", baseArgs: [] };
}

function runPackageManager(args: string[]) {
  const { command, baseArgs } = getPackageManagerCommand();
  return spawn(command, [...baseArgs, ...args], {
    cwd: GUI_DIR,
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
  });
}

function runPackageManagerSync(args: string[]) {
  const { command, baseArgs } = getPackageManagerCommand();
  const result = spawnSync(command, [...baseArgs, ...args], {
    cwd: GUI_DIR,
    stdio: ["ignore", "inherit", "inherit"],
    shell: false,
  });

  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`Package manager command failed with exit code ${result.status}`);
  }
}

/**
 * Bridges Electron Forge's VitePlugin renderer lifecycle to the SvelteKit
 * project in `gui/`.
 *
 * - Build mode: runs `pnpm run build` inside `gui/`. SvelteKit's adapter-static
 *   writes directly to `.vite/build/gui`, which is exactly where Forge expects
 *   the renderer output.
 * - Dev mode (serve): spawns `pnpm run dev` inside `gui/` on a fixed port and
 *   proxies all requests from the Forge-managed Vite dev server to it.
 */
function svelteKitPlugin(): Plugin {
  let devProcess: ReturnType<typeof spawn> | null = null;

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

    configureServer(server) {
      devProcess = runPackageManager([
        "run",
        "dev",
        "--",
        "--port",
        String(SVELTEKIT_DEV_PORT),
      ]);
      server.httpServer?.on("close", () => devProcess?.kill());
    },

    buildStart() {
      if (!this.meta.watchMode) {
        runPackageManagerSync(["run", "build"]);
      }
    },

    // Rollup requires at least one input entry; resolve this virtual module to
    // an empty module so the Rollup pass produces no real output of its own.
    resolveId(id) {
      if (id === "virtual:sveltekit-bridge")
        return "\0virtual:sveltekit-bridge";
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
});

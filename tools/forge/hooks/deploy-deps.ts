import { fork } from "node:child_process";
import { resolve } from "node:path";

import { PROJECT_ROOT } from "../../shared/paths.ts";

const DEPLOY_SCRIPT = resolve(PROJECT_ROOT, "tools/scripts/deploy-deps.ts");

/**
 * Replace workspace modules with their packed versions before the app is
 * copied, so module source code is not bundled into the packaged app.
 *
 * `FORGE_BUILD_ONLY` aborts before the mutation; the E2E setup uses it to run
 * only the Vite build.
 */
export async function deployDependencies(): Promise<void> {
  if ("FORGE_BUILD_ONLY" in process.env) throw new Error("FORGE_BUILD_ONLY");

  await new Promise<void>((resolve, reject) => {
    const proc = fork(DEPLOY_SCRIPT, [], { cwd: PROJECT_ROOT });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) reject(code);
      resolve();
    });
  });
}

/** Best effort to restore the workspace links; never fail the build on it. */
export async function restoreDependencies(): Promise<void> {
  await new Promise<void>((resolve) => {
    const proc = fork(DEPLOY_SCRIPT, ["--restore"], { cwd: PROJECT_ROOT });
    proc.on("error", resolve);
    proc.on("exit", resolve);
  });
}

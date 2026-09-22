import { resolve } from "node:path";
import { cp, mkdir, readdir, rm } from "node:fs/promises";

import { rpmArch } from "../common/arch.ts";
import { runStreaming } from "../common/process.ts";
import { cleanOutDir } from "../common/util.ts";
import { buildSrpm, type BuildSrpmOptions } from "./srpm.ts";

export interface BuildRpmOptions extends BuildSrpmOptions {
  /** Node/Electron arch name (e.g. `x64`) used in the default `outDir`. Defaults to the host arch. */
  arch?: string | undefined;
}

/**
 * Build binary RPMs: generate the SRPM (with an optional `prebuilt` app
 * bundled as Source1), then `rpmbuild --rebuild` it. Returns the produced
 * `.rpm` paths.
 */
export async function buildRpm(
  options: BuildRpmOptions = {}
): Promise<string[]> {
  const projectRoot =
    options.projectRoot ?? resolve(import.meta.dirname, "../..");
  const outDir =
    options.outDir ??
    resolve(projectRoot, "out/make/rpm", rpmArch(options.arch));
  // Empty the directory first so stale artifacts from earlier runs (e.g. an
  // older version) can't be mistaken for this build's output.
  await cleanOutDir(outDir, options.clean);

  const srpms = await buildSrpm({
    ...options,
    projectRoot,
    outDir: resolve(outDir, "srpm"),
    // The SRPM is a private intermediate here, so it is always rebuilt from
    // scratch regardless of the caller's `clean` choice.
    clean: true,
  });

  const topdir = resolve(outDir, "rpmbuild");
  await mkdir(topdir, { recursive: true });

  const rpms: string[] = [];
  for (const srpm of srpms) {
    const rebuildArgs = ["--define", `_topdir ${topdir}`, "--rebuild"];
    if (options.nodeps) rebuildArgs.push("--nodeps");
    rebuildArgs.push(srpm);
    await runStreaming("rpmbuild", rebuildArgs);

    // Collect the produced binary RPM(s) from RPMS/<arch>/.
    const rpmsRoot = resolve(topdir, "RPMS");
    for (const arch of await readdir(rpmsRoot)) {
      const archDir = resolve(rpmsRoot, arch);
      for (const f of await readdir(archDir)) {
        if (!f.endsWith(".rpm")) continue;
        const dest = resolve(outDir, f);
        await cp(resolve(archDir, f), dest);
        rpms.push(dest);
      }
    }
  }

  await rm(topdir, { recursive: true, force: true });
  // The SRPM was only an intermediate for the rebuild; remove it so only the
  // binary .rpm remains in the output directory.
  await rm(resolve(outDir, "srpm"), { recursive: true, force: true });
  return rpms;
}

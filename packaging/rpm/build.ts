import { resolve } from "node:path";
import { cp, mkdir, readdir, rm } from "node:fs/promises";

import { runStreaming } from "../common/process.ts";
import { buildSrpm, type BuildSrpmOptions } from "./srpm.ts";

export type BuildRpmOptions = BuildSrpmOptions;

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
  const outDir = options.outDir ?? resolve(projectRoot, "out/make/rpm");

  const srpms = await buildSrpm({
    ...options,
    projectRoot,
    outDir: resolve(outDir, "srpm"),
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

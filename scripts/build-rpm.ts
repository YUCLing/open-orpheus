import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { cp, mkdir, readdir, rm } from "node:fs/promises";

import { buildSrpm } from "../packaging/rpm/srpm.ts";

/** Run a long-running command, streaming its output to the parent process. */
function runStreaming(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

const projectRoot = resolve(import.meta.dirname, "..");
const outDir = resolve(projectRoot, "out/make/rpm");

const installTools = process.argv.includes("--install-tools");

// 1. Build the SRPM (the single source of truth), then rebuild it into a
//    binary RPM. `rpmbuild --rebuild` runs the full %prep/%build/%install
//    inside rpmbuild — i.e. it compiles the app from source, the same way
//    Copr does — so the resulting binary RPM matches the Copr build exactly.
const srpms = await buildSrpm({ installTools });

const topdir = resolve(outDir, "rpmbuild");
await mkdir(topdir, { recursive: true });

const rpms: string[] = [];
for (const srpm of srpms) {
  await runStreaming("rpmbuild", [
    "--define",
    `_topdir ${topdir}`,
    "--rebuild",
    srpm,
  ]);

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

console.log("RPM(s) created:");
for (const f of rpms) {
  console.log(`  ${f}`);
}

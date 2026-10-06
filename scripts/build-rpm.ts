import { resolve } from "node:path";

import { buildRpm } from "../packaging/rpm/build.ts";
import { parseFlags } from "../packaging/common/cli.ts";
import { resolvePrebuiltAppDir } from "../packaging/common/prebuilt.ts";
import pkg from "../package.json" with { type: "json" };

const projectRoot = resolve(import.meta.dirname, "..");
const flags = parseFlags(process.argv.slice(2));

const prebuilt = flags.prebuilt
  ? await resolvePrebuiltAppDir(projectRoot, pkg.name, flags.arch)
  : undefined;

// Build the SRPM (with the packaged app bundled as Source1 when `--prebuilt`),
// then `rpmbuild --rebuild` it into binary RPMs.
// Output lands in `out/make/rpm/<rpmArch>` (`--arch`, defaulting to the host arch).
const rpms = await buildRpm({
  installTools: flags.installTools,
  nodeps: flags.nodeps,
  prebuilt,
  arch: flags.arch,
  clean: flags.clean,
});

console.log("RPM(s) created:");
for (const f of rpms) {
  console.log(`  ${f}`);
}

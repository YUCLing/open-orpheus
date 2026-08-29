import { resolve } from "node:path";

import { buildRpm } from "../packaging/rpm/build.ts";
import { parseFlags } from "../packaging/common/cli.ts";
import { resolvePrebuiltAppDir } from "../packaging/common/prebuilt.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const flags = parseFlags(process.argv.slice(2));

const { rpm: rpmOptions } = await import(
  new URL("../packaging/options.ts", import.meta.url).href
);
const prebuilt = flags.prebuilt
  ? await resolvePrebuiltAppDir(projectRoot, rpmOptions.name, flags.arch)
  : undefined;

// Build the SRPM (with the packaged app bundled as Source1 when `--prebuilt`),
// then `rpmbuild --rebuild` it into binary RPMs.
const rpms = await buildRpm({
  installTools: flags.installTools,
  nodeps: flags.nodeps,
  prebuilt,
});

console.log("RPM(s) created:");
for (const f of rpms) {
  console.log(`  ${f}`);
}

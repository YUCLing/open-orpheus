import { resolve } from "node:path";

import { buildSrpm } from "../packaging/rpm/srpm.ts";
import { parseFlags } from "../packaging/common/cli.ts";
import { resolvePrebuiltAppDir } from "../packaging/common/prebuilt.ts";
import pkg from "../package.json" with { type: "json" };

const projectRoot = resolve(import.meta.dirname, "..");
const flags = parseFlags(process.argv.slice(2));

const prebuilt = flags.prebuilt
  ? await resolvePrebuiltAppDir(projectRoot, pkg.name, flags.arch)
  : undefined;

const srpms = await buildSrpm({
  installTools: flags.installTools,
  nodeps: flags.nodeps,
  prebuilt,
  clean: flags.clean,
});

console.log("SRPM(s) created:");
for (const f of srpms) {
  console.log(`  ${f}`);
}

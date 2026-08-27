import { resolve } from "node:path";

import { buildSrpm } from "../packaging/rpm/srpm.ts";
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

const srpms = await buildSrpm({
  installTools: flags.installTools,
  nodeps: flags.nodeps,
  prebuilt,
});

console.log("SRPM(s) created:");
for (const f of srpms) {
  console.log(`  ${f}`);
}

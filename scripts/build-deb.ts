import { resolve } from "node:path";

import { buildDeb } from "../packaging/deb/source.ts";
import { parseFlags } from "../packaging/common/cli.ts";
import { resolvePrebuiltAppDir } from "../packaging/common/prebuilt.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const flags = parseFlags(process.argv.slice(2));

const { deb: debOptions } = await import(
  new URL("../packaging/options.ts", import.meta.url).href
);
const prebuilt = flags.prebuilt
  ? await resolvePrebuiltAppDir(projectRoot, debOptions.name, flags.arch)
  : undefined;

// Bake the toolchain install (rust/node/pnpm) into debian/rules. Opt-in via
// `--install-tools`; defaults to off (assumes a preinstalled toolchain).
// With `--prebuilt`, bundle the packaged app and skip compiling.
const debs = await buildDeb({
  installTools: flags.installTools,
  nodeps: flags.nodeps,
  prebuilt,
});

console.log("DEB(s) created:");
for (const f of debs) {
  console.log(`  ${f}`);
}

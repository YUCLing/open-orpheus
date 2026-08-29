import { resolve } from "node:path";

import { buildDebSource } from "../packaging/deb/source.ts";
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
// `--install-tools`: PPA builders are clean hosts, so pass it unless the
// builder already has the toolchain (Build-Depends only covers C/C++).
// With `--prebuilt`, bundle the packaged app into the source package and the
// PPA build installs it instead of compiling.
const files = await buildDebSource({
  installTools: flags.installTools,
  nodeps: flags.nodeps,
  prebuilt,
});

console.log("Debian source package created:");
for (const f of files) {
  console.log(`  ${f}`);
}

const dsc = files.find((f) => f.endsWith(".dsc"));
if (dsc) {
  console.log(`\nUpload with: dput ppa:YOUR/PPA ${dsc}`);
}

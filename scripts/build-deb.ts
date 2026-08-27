import { buildDeb } from "../packaging/deb/source.ts";

// Bake the toolchain install (rust/node/pnpm) into debian/rules. Opt-in via
// `--install-tools`; defaults to off (assumes a preinstalled toolchain).
const installTools = process.argv.includes("--install-tools");
const nodeps = process.argv.includes("--nodeps");

const debs = await buildDeb({ installTools, nodeps });

console.log("DEB(s) created:");
for (const f of debs) {
  console.log(`  ${f}`);
}

import { buildDeb } from "../packaging/deb/source.ts";

// Install the build toolchain (rust/node/pnpm) inside debian/rules unless
// explicitly disabled, e.g. INSTALL_TOOLS=0 node scripts/build-deb.ts
const installTools = process.argv.includes("--install-tools");

const debs = await buildDeb({ installTools });

console.log("DEB(s) created:");
for (const f of debs) {
  console.log(`  ${f}`);
}

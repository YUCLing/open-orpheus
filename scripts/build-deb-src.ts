import { buildDebSource } from "../packaging/deb/source.ts";

// Bake the toolchain install (rust/node/pnpm) into debian/rules. Opt-in via
// `--install-tools`: PPA builders are clean hosts, so pass it unless the
// builder already has the toolchain (Build-Depends only covers C/C++).
const installTools = process.argv.includes("--install-tools");
const nodeps = process.argv.includes("--nodeps");

const files = await buildDebSource({ installTools, nodeps });

console.log("Debian source package created:");
for (const f of files) {
  console.log(`  ${f}`);
}

const dsc = files.find((f) => f.endsWith(".dsc"));
if (dsc) {
  console.log(`\nUpload with: dput ppa:YOUR/PPA ${dsc}`);
}

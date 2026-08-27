import { buildDebSource } from "../packaging/deb/source.ts";

const files = await buildDebSource();

console.log("Debian source package created:");
for (const f of files) {
  console.log(`  ${f}`);
}

const dsc = files.find((f) => f.endsWith(".dsc"));
if (dsc) {
  console.log(`\nUpload with: dput ppa:YOUR/PPA ${dsc}`);
}

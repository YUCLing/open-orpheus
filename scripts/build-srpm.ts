import { buildSrpm } from "../packaging/rpm/srpm.ts";

const installTools = process.argv.includes("--install-tools");
const nodeps = process.argv.includes("--nodeps");

const srpms = await buildSrpm({ installTools, nodeps });

console.log("SRPM(s) created:");
for (const f of srpms) {
  console.log(`  ${f}`);
}

import { buildSrpm } from "../packaging/rpm/srpm";

const installTools = process.argv.includes("--install-tools");

const srpms = await buildSrpm({ installTools });

console.log("SRPM(s) created:");
for (const f of srpms) {
  console.log(`  ${f}`);
}

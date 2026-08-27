import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import ejs from "ejs";

const template = resolve(import.meta.dirname, "../resources/debian/rules.ejs");

export interface RulesOptions {
  /** Install the build toolchain (rust/node/pnpm) inside `override_dh_auto_build`. Defaults to true. */
  installTools?: boolean;
}

export async function generateRules(options: RulesOptions) {
  return new Promise<string>((resolve, reject) => {
    ejs.renderFile(template, options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

export async function createRulesFile(path: string, options: RulesOptions) {
  const result = await generateRules(options);
  await writeFile(path, result, { encoding: "utf-8" });
}

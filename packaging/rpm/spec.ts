import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import ejs from "ejs";

const template = resolve(import.meta.dirname, "../resources/srpm.spec.ejs");

export interface SpecOptions {
  name: string;
  version: string;
  release: string;
  summary: string;
  description: string;
  license: string;
  homepage: string;
  nodeVersion: string;
  wasmBindgen: string;
  changelog: string;
  /** Install the build toolchain (rust/node/pnpm) inside `%build`. Defaults to true. */
  installTools?: boolean;
}

export async function generateSpec(options: SpecOptions) {
  return new Promise<string>((resolve, reject) => {
    ejs.renderFile(template, options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

export async function createSpecFile(path: string, options: SpecOptions) {
  const result = await generateSpec(options);
  await writeFile(path, result, { encoding: "utf-8" });
}

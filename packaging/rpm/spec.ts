import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import ejs from "ejs";

import { RUST_VERSION } from "../common/toolchain.ts";

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
  /** Rust toolchain version installed via rustup. Defaults to `RUST_VERSION`. */
  rust?: string;
  changelog: string;
  /** Install the build toolchain (rust/node/pnpm) inside `%build`. Defaults to true. */
  installTools?: boolean;
  /** Bundle a prebuilt Electron app (Source1) and skip building. Defaults to false. */
  prebuilt?: boolean;
}

export async function generateSpec(options: SpecOptions) {
  return new Promise<string>((resolve, reject) => {
    ejs.renderFile(
      template,
      {
        ...options,
        rust: options.rust ?? RUST_VERSION,
        installTools: options.installTools ?? true,
        prebuilt: options.prebuilt ?? false,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
  });
}

export async function createSpecFile(path: string, options: SpecOptions) {
  const result = await generateSpec(options);
  await writeFile(path, result, { encoding: "utf-8" });
}

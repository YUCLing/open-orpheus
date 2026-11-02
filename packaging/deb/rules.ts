import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import ejs from "ejs";

import { RUST_VERSION } from "../common/toolchain.ts";

const template = resolve(import.meta.dirname, "../resources/debian/rules.ejs");

export interface RulesOptions {
  /** Package/executable name (passed to build-scaffold.ts --name). */
  name: string;
  /** Rust toolchain version installed via rustup. Defaults to `RUST_VERSION`. */
  rust?: string;
  /** Install the build toolchain (rust/node/pnpm) inside `override_dh_auto_build`. Defaults to true. */
  installTools?: boolean;
  /** Install a bundled prebuilt app (prebuilt/) instead of compiling. Defaults to false. */
  prebuilt?: boolean;
}

export async function generateRules(options: RulesOptions) {
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

export async function createRulesFile(path: string, options: RulesOptions) {
  const result = await generateRules(options);
  await writeFile(path, result, { encoding: "utf-8" });
}

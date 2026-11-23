import { resolve } from "node:path";

import { renderTemplate, writeTemplate } from "../common/template.ts";

import { RUST_VERSION } from "../../config/toolchain.ts";

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

export function rulesTemplateData(options: RulesOptions): Record<string, unknown> {
  return {
    ...options,
    rust: options.rust ?? RUST_VERSION,
    installTools: options.installTools ?? true,
    prebuilt: options.prebuilt ?? false,
  };
}

export async function generateRules(options: RulesOptions) {
  return renderTemplate(template, rulesTemplateData(options));
}

export async function createRulesFile(path: string, options: RulesOptions) {
  await writeTemplate(path, template, rulesTemplateData(options));
}

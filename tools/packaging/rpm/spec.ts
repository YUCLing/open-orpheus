import { resolve } from "node:path";

import { renderTemplate, writeTemplate } from "../common/template.ts";

import { RUST_VERSION } from "../../config/toolchain.ts";

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

export function specTemplateData(options: SpecOptions): Record<string, unknown> {
  return {
    ...options,
    rust: options.rust ?? RUST_VERSION,
    installTools: options.installTools ?? true,
    prebuilt: options.prebuilt ?? false,
  };
}

export async function generateSpec(options: SpecOptions) {
  return renderTemplate(template, specTemplateData(options));
}

export async function createSpecFile(path: string, options: SpecOptions) {
  await writeTemplate(path, template, specTemplateData(options));
}

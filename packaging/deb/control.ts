import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import ejs from "ejs";

import type { MakerDebOptions } from "../types.ts";

const template = resolve(
  import.meta.dirname,
  "../resources/debian/control.ejs"
);

export interface ControlOptions {
  name: string;
  section: string;
  maintainer: string;
  homepage: string;
  description: string;
}

function formatMaintainer(author: unknown): string {
  if (typeof author === "string") return author;
  const { name = "", email = "" } = (author ?? {}) as {
    name?: string;
    email?: string;
  };
  return email ? `${name} <${email}>` : name;
}

/** Indent continuation lines of a Debian `Description` with a leading space. */
function normalizeDescription(description: string): string {
  return description.replace(/\n/g, "\n ");
}

/** Resolve the control fields from the deb options + package.json defaults. */
export function resolveControlOptions(
  options: MakerDebOptions,
  pkg: {
    name?: string;
    author?: unknown;
    homepage?: string;
    description?: string;
  }
): ControlOptions {
  return {
    name: options.name ?? pkg.name ?? "open-orpheus",
    section: options.section ?? "sound",
    maintainer: options.maintainer ?? formatMaintainer(pkg.author),
    homepage: options.homepage ?? pkg.homepage ?? "",
    description: normalizeDescription(
      options.description ?? pkg.description ?? ""
    ),
  };
}

export async function generateControl(options: ControlOptions) {
  return new Promise<string>((resolve, reject) => {
    ejs.renderFile(template, options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

export async function createControlFile(path: string, options: ControlOptions) {
  const result = await generateControl(options);
  await writeFile(path, result, { encoding: "utf-8" });
}

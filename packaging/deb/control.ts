import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import ejs from "ejs";

const template = resolve(import.meta.dirname, "../resources/debian/control.ejs");

export interface ControlOptions {
  name: string;
  section: string;
  maintainer: string;
  homepage: string;
  description: string;
}

/**
 * Overrides for the rendered `debian/control`. Every field is optional: unset
 * ones fall back to `package.json` (or the Debian default), so callers only
 * supply what npm cannot — currently the homepage and the long description,
 * which live in the shared `packaging/resources/metadata.ts`.
 */
export interface ControlMetadata {
  /** Package name. Defaults to package.json `name`. */
  name?: string;
  /** Debian section. Defaults to `"sound"`. */
  section?: string;
  /** Maintainer in `Name <email>` form. Defaults to package.json `author`. */
  maintainer?: string;
  /** Homepage URL. Defaults to package.json `homepage`. */
  homepage?: string;
  /** Short description (continuation lines are indented automatically). Defaults to package.json `description`. */
  description?: string;
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

/** Resolve the control fields from the metadata overrides + package.json defaults. */
export function resolveControlOptions(
  metadata: ControlMetadata,
  pkg: {
    name?: string;
    author?: unknown;
    homepage?: string;
    description?: string;
  }
): ControlOptions {
  return {
    name: metadata.name ?? pkg.name ?? "open-orpheus",
    section: metadata.section ?? "sound",
    maintainer: metadata.maintainer ?? formatMaintainer(pkg.author),
    homepage: metadata.homepage ?? pkg.homepage ?? "",
    description: normalizeDescription(metadata.description ?? pkg.description ?? ""),
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

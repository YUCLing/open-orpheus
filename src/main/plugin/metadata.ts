import path from "node:path";

import { z } from "zod";

import { sanitizeRelativePath } from "../util/path";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether `value` is a relative path that stays inside the plugin tree.
 *
 * `sanitizeRelativePath` handles the containment check; the extra guards reject
 * absolute paths (which `sanitizeRelativePath` would rebase under the base) and
 * inputs the path resolver cannot handle.
 */
function isPluginPath(base: string, value: string): boolean {
  if (value.length === 0 || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  try {
    return sanitizeRelativePath(base, value) !== false;
  } catch {
    return false;
  }
}

function createMetadataSchema(base: string) {
  const safeRelativePath = z.string().refine((value) => isPluginPath(base, value), {
    error: "must be a relative path inside the plugin directory",
  });

  const mainRealmEntry = safeRelativePath.refine((value) => value.endsWith(".mjs"), {
    error: "must point at an .mjs file",
  });

  const preloadRealmEntry = safeRelativePath.refine((value) => value.endsWith(".cjs"), {
    error: "must point at a .cjs file",
  });

  const safeAssetPath = z
    .string()
    .refine((value) => isPluginPath(path.join(base, "assets"), value), {
      error: "must be a relative path inside the plugin's assets directory",
    });

  return z.object({
    id: z
      .string()
      .regex(
        ID_PATTERN,
        "must start with a letter or digit and contain only letters, digits, '.', '_' or '-'"
      ),
    name: z.string().min(1, "must not be empty"),
    version: z.string().min(1, "must not be empty"),
    description: z.string().min(1, "must not be empty").optional(),
    author: z.string().min(1, "must not be empty").optional(),
    homepage: z.string().min(1, "must not be empty").optional(),
    license: z.string().min(1, "must not be empty").optional(),
    /** Path relative to the plugin's `assets/` directory. */
    icon: safeAssetPath.optional(),
    realms: z.object({
      main: mainRealmEntry,
      preload: preloadRealmEntry.optional(),
    }),
  });
}

export type PluginMetadata = z.infer<ReturnType<typeof createMetadataSchema>>;

/**
 * Validate a parsed `metadata.json`.
 *
 * Unknown fields are ignored. The error message names the plugin source and
 * lists every failing field.
 */
export function parsePluginMetadata(raw: unknown, source: string): PluginMetadata {
  const result = createMetadataSchema(source).safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid metadata.json in ${source}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

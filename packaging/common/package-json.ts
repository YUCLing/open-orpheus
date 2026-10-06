import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Typed access to the `package.json` of the tree being built.
 *
 * The packaging builders accept a `projectRoot` and read that tree's sources,
 * `Cargo.toml` and changelogs, so their npm identity has to come from the same
 * place. A module-relative JSON import would always resolve to this checkout and
 * silently mix this repository's name/version/license with another tree's files.
 */

/** The shape of `package.json`, derived from this repository's file so it cannot drift. */
export type PackageJson = typeof import("../../package.json");

/** Read `<projectRoot>/package.json`. */
export async function readPackageJson(projectRoot: string): Promise<PackageJson> {
  return JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf-8"));
}

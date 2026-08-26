import { dirname, relative, resolve } from "node:path";
import { mkdir, rm, symlink } from "node:fs/promises";

/**
 * Create a symlink at `to` that points to `from`.
 *
 * Both arguments may be relative (resolved against the current working
 * directory) or absolute. The link target is computed relative to the link's
 * parent directory, so the resulting link is relocatable.
 */
export async function createSymlink(from: string, to: string) {
  const linkPath = resolve(to);
  const linkTarget = relative(dirname(linkPath), resolve(from));

  await mkdir(dirname(linkPath), { recursive: true });
  // Remove any existing entry first so re-runs are idempotent.
  await rm(linkPath, { force: true });
  await symlink(linkTarget, linkPath);
}

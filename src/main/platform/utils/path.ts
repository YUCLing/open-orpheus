import os from "node:os";
import { join, normalize, resolve, sep } from "node:path";

export function normalizePath(...paths: string[]): string {
  return normalize(
    join(...paths.map((path) => (os.platform() === "win32" ? path : path.replaceAll("\\", "/"))))
  );
}

export function sanitizeRelativePath(base: string, path: string): string | false {
  const resolvedBase = resolve(base);
  const normalizedPath = normalizePath(path);
  const resolvedPath = resolve(join(resolvedBase, normalizedPath));
  const baseWithSep = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(baseWithSep)) {
    return false;
  }
  return resolvedPath;
}

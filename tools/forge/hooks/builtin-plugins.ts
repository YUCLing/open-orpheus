import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { resolve } from "node:path";

import { PROJECT_ROOT } from "../../shared/paths.ts";

/** Copy built-in plugins into the app directory before asar packaging. */
export async function copyBuiltinPlugins({ buildPath }: { buildPath: string }): Promise<void> {
  const source = resolve(PROJECT_ROOT, "out", "builtin-plugins");
  if (!existsSync(source)) return;
  await cp(source, resolve(buildPath, "builtin-plugins"), { recursive: true });
}

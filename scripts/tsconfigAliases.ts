import path from "node:path";

import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const TSCONFIG = path.join(ROOT, "tsconfig.json");

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Generate one alias map from the root `tsconfig.json`'s `compilerOptions.paths`.
 *
 * Values are absolute (POSIX) paths, which both Vite's `resolve.alias` and
 * SvelteKit's `kit.alias` accept. Only trailing `/*` patterns are supported;
 * `baseUrl` is not consulted (it is deprecated in TypeScript 6 and stops
 * functioning in 7).
 */
export function createAliases(): Record<string, string> {
  const read = ts.readConfigFile(TSCONFIG, (file) => ts.sys.readFile(file));
  if (read.error) {
    throw new Error(
      `Failed to read ${TSCONFIG}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`
    );
  }

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(TSCONFIG));
  const errors = parsed.errors.filter((error) => error.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(
      `Invalid ${TSCONFIG}:\n${errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n")}`
    );
  }

  // `pathsBasePath` is where the tsconfig that declared `paths` lives. It is
  // set by `parseJsonConfigFileContent` but missing from the public type.
  const options = parsed.options as ts.CompilerOptions & { pathsBasePath?: string };
  const basePath = options.pathsBasePath ?? path.dirname(TSCONFIG);

  const aliases: Record<string, string> = {};

  for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
    const target = targets[0];
    if (target === undefined) continue;

    if (!pattern.endsWith("/*") || !target.endsWith("/*")) {
      throw new Error(
        `Unsupported path mapping "${pattern}" -> "${target}"; only trailing "/*" patterns are supported`
      );
    }

    aliases[pattern.slice(0, -2)] = toPosixPath(path.resolve(basePath, target.slice(0, -2)));
  }

  return aliases;
}

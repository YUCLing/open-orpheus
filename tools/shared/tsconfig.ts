import path from "node:path";

import ts from "typescript";

import { PROJECT_ROOT } from "./paths.ts";

/** A `tsconfig.json` `paths` entry, resolved to an absolute target directory. */
export interface PathAlias {
  /** Alias without the trailing `/*`, e.g. `@main`. */
  alias: string;
  /** Absolute target directory, e.g. `/repo/src/main`. */
  target: string;
}

export interface ProjectTsconfig {
  root: string;
  tsconfigPath: string;
  compilerOptions: ts.CompilerOptions;
  /** Aliases sorted longest-target-first, so nested targets win. */
  aliases: PathAlias[];
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Read the project's root `tsconfig.json` and resolve its `paths` aliases.
 *
 * Only trailing `/*` patterns are supported; `baseUrl` is not consulted (it is
 * deprecated in TypeScript 6 and stops functioning in 7).
 */
export function readProjectTsconfig(root: string = PROJECT_ROOT): ProjectTsconfig {
  const resolvedRoot = path.resolve(root);
  const tsconfigPath = path.join(resolvedRoot, "tsconfig.json");
  const read = ts.readConfigFile(tsconfigPath, (file) => ts.sys.readFile(file));
  if (read.error) {
    throw new Error(
      `Failed to read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`
    );
  }

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, resolvedRoot);
  const errors = parsed.errors.filter((error) => error.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(
      `Invalid ${tsconfigPath}:\n${errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n")}`
    );
  }

  // `pathsBasePath` is where the tsconfig that declared `paths` lives. It is
  // set by `parseJsonConfigFileContent` but missing from the public type.
  const compilerOptions = parsed.options as ts.CompilerOptions & { pathsBasePath?: string };
  const basePath = compilerOptions.pathsBasePath ?? resolvedRoot;

  const aliases: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(compilerOptions.paths ?? {})) {
    const target = targets[0];
    if (target === undefined) continue;

    if (!pattern.endsWith("/*") || !target.endsWith("/*")) {
      throw new Error(
        `Unsupported path mapping "${pattern}" -> "${target}"; only trailing "/*" patterns are supported`
      );
    }

    aliases.push({
      alias: pattern.slice(0, -2),
      target: path.resolve(basePath, target.slice(0, -2)),
    });
  }
  // Longest target first, so `src/main/foo.ts` resolves to `@main/foo` rather
  // than to `@/main/foo`.
  aliases.sort((a, b) => b.target.length - a.target.length);

  return { root: resolvedRoot, tsconfigPath, compilerOptions, aliases };
}

/**
 * Generate one alias map from the root `tsconfig.json`'s `compilerOptions.paths`.
 *
 * Values are absolute (POSIX) paths, which both Vite's `resolve.alias` and
 * SvelteKit's `kit.alias` accept.
 */
export function createAliases(root?: string): Record<string, string> {
  const { aliases } = readProjectTsconfig(root);
  const map: Record<string, string> = {};
  for (const { alias, target } of aliases) {
    map[alias] = toPosixPath(target);
  }
  return map;
}

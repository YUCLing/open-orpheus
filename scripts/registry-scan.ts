import path from "node:path";

import ts from "typescript";

/**
 * Shared reader for the plugin interface.
 *
 * Both consumers use this and nothing else to learn the host surface:
 *
 * - `plugins/RegistryPlugin.ts` renders the build-time virtual registry.
 * - `packages/plugin-api/scripts/build.ts` emits the SDK type declarations.
 *
 * Keys and module resolution come from the root `tsconfig.json` `paths`, so
 * aliases have exactly one source of truth. This module only reads; it never
 * writes generated artifacts.
 */
export const IMPORT_EXTENSIONS = /\.(?:[cm]?[jt]sx?|mjs|cjs)$/;

/**
 * Paths (relative to `src/`) that are part of the plugin framework rather than
 * the host surface, or that live in other build realms.
 */
export type RealmId = "main" | "preload";

export const REALM_IDS: RealmId[] = ["main", "preload"];

interface RealmScanConfig {
  /** Entry files relative to the project root. */
  entries: string[];
  /** Prefixes (relative to `src/`) to exclude from the surface. */
  excludedPrefixes: string[];
  /** Paths without extension (relative to `src/`) that are the entry itself. */
  excludedFiles: Set<string>;
}

const REALMS: Record<RealmId, RealmScanConfig> = {
  main: {
    entries: ["src/main.ts"],
    excludedPrefixes: ["main/plugin/", "preload/", "worklets/"],
    excludedFiles: new Set(["main"]),
  },
  preload: {
    entries: ["src/preload.ts"],
    excludedPrefixes: ["main/", "preload/plugin/", "worklets/"],
    excludedFiles: new Set(["preload"]),
  },
};

export interface RegistryEntry {
  /** Canonical public key, e.g. `@main/lifecycle`. */
  key: string;
  /** Source file that backs the key. */
  file: string;
}

export interface Alias {
  /** tsconfig path alias without the trailing `/*`, e.g. `@main`. */
  alias: string;
  /** Absolute target directory, e.g. `/repo/src/main`. */
  target: string;
}

export interface RegistryScanOptions {
  /** Project root. Defaults to the current working directory. */
  root?: string;
  /** Realm to scan. Defaults to `main`. */
  realm?: RealmId;
}

interface ProjectConfig {
  compilerOptions: ts.CompilerOptions;
  aliases: Alias[];
  root: string;
}

interface ImportScan {
  staticSpecifiers: string[];
  dynamicSpecifiers: string[];
}

/**
 * Collect every module reachable from a realm's entry points.
 *
 * Every entry is a lazy dynamic import; there is no eager/lazy split and no
 * platform classification. Keys are derived from the root `tsconfig.json`
 * `paths`, so `@main/*`, `@preload/*`, `@shared/*`, `@/*`, etc. are not
 * hardcoded here.
 */
export function collectRegistryEntries(options: RegistryScanOptions = {}): RegistryEntry[] {
  const { root, realm = "main" } = options;
  const config = REALMS[realm];
  const { compilerOptions, aliases, root: resolvedRoot } = readProjectConfig(root);
  const srcRoot = path.join(resolvedRoot, "src");
  const entries = config.entries.map((entry) => path.join(resolvedRoot, entry));

  const visited = new Set<string>(entries);
  const queue: string[] = [...entries];

  while (queue.length > 0) {
    const file = queue.pop()!;
    const text = ts.sys.readFile(file);
    if (text === undefined) continue;

    const { staticSpecifiers, dynamicSpecifiers } = scanImports(file, text);
    for (const specifier of [...staticSpecifiers, ...dynamicSpecifiers]) {
      const resolved = resolveSpecifier(specifier, file, compilerOptions, srcRoot);
      if (!resolved) continue;
      if (!visited.has(resolved)) {
        visited.add(resolved);
        queue.push(resolved);
      }
    }
  }

  const byKey = new Map<string, string>();
  for (const file of visited) {
    if (!isRegistryCandidate(file, srcRoot, config)) continue;
    const key = toAliasKey(file, aliases);
    if (key) byKey.set(key, file);
  }

  return [...byKey.entries()]
    .map(([key, file]) => ({ key, file }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Read the root `tsconfig.json` `paths` as alias → absolute target pairs. */
export function readAliases(root?: string): Alias[] {
  return readProjectConfig(root).aliases;
}

/** Read the root `tsconfig.json` compiler options. */
export function readCompilerOptions(root?: string): ts.CompilerOptions {
  return readProjectConfig(root).compilerOptions;
}

function readProjectConfig(rootOption?: string): ProjectConfig {
  const root = path.resolve(rootOption ?? process.cwd());
  const tsconfigPath = path.join(root, "tsconfig.json");
  const config = ts.readConfigFile(tsconfigPath, (fileName) => ts.sys.readFile(fileName));
  if (config.error) {
    throw new Error(
      `Failed to read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`
    );
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const errors = parsed.errors.filter((error) => error.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(
      `Invalid ${tsconfigPath}:\n${errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n")}`
    );
  }

  const compilerOptions = parsed.options as ts.CompilerOptions & { pathsBasePath?: string };
  const basePath = compilerOptions.pathsBasePath ?? root;
  const aliases: Alias[] = [];
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

  return { compilerOptions, aliases, root };
}

function scanImports(fileName: string, text: string): ImportScan {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  const staticSpecifiers: string[] = [];
  const dynamicSpecifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (
        node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        staticSpecifiers.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      staticSpecifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      staticSpecifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) dynamicSpecifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { staticSpecifiers, dynamicSpecifiers };
}

function resolveSpecifier(
  specifier: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
  srcRoot: string
): string | null {
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    ts.sys
  ).resolvedModule;
  if (!resolved) return null;
  const file = path.resolve(resolved.resolvedFileName);
  // The registry only hosts modules of this realm; native/external packages are
  // directly importable by a main-process plugin and stay out of it.
  if (!isUnder(file, srcRoot)) return null;
  if (!IMPORT_EXTENSIONS.test(file)) return null;
  return file;
}

function isRegistryCandidate(file: string, srcRoot: string, config: RealmScanConfig): boolean {
  if (!isUnder(file, srcRoot)) return false;
  const relativePath = path.relative(srcRoot, file).split(path.sep).join("/");
  if (!IMPORT_EXTENSIONS.test(relativePath)) return false;
  if (config.excludedPrefixes.some((prefix) => relativePath.startsWith(prefix))) return false;
  const withoutExtension = relativePath.replace(IMPORT_EXTENSIONS, "");
  return !config.excludedFiles.has(withoutExtension);
}

function toAliasKey(file: string, aliases: Alias[]): string | null {
  for (const { alias, target } of aliases) {
    if (!isUnder(file, target)) continue;
    const relativePath = path
      .relative(target, file)
      .split(path.sep)
      .join("/")
      .replace(IMPORT_EXTENSIONS, "");
    return `${alias}/${relativePath}`;
  }
  return null;
}

function isUnder(file: string, directory: string): boolean {
  const relativePath = path.relative(directory, file);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

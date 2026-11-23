import path from "node:path";

import ts from "typescript";

/**
 * Shared reader for the plugin interface.
 *
 * Both consumers use this and nothing else to learn the host surface:
 *
 * - `tools/forge/plugins/RegistryPlugin.ts` renders the build-time virtual registry.
 * - `packages/plugin-api/scripts/build.ts` emits the SDK type declarations.
 *
 * Keys and module resolution come from the root `tsconfig.json` `paths`, so
 * aliases have exactly one source of truth. This module only reads; it never
 * writes generated artifacts.
 */
import { PROJECT_ROOT } from "../shared/paths.ts";
import { readProjectTsconfig, type PathAlias } from "../shared/tsconfig.ts";
import { REALMS, type RealmId } from "../config/realms.ts";
import type { RealmScanConfig } from "./realms.types.ts";

export const IMPORT_EXTENSIONS = /\.(?:[cm]?[jt]sx?|mjs|cjs)$/;

export interface RegistryEntry {
  /** Canonical public key, e.g. `@main/lifecycle`. */
  key: string;
  /** Source file that backs the key. */
  file: string;
}

export type Alias = PathAlias;

export interface RegistryScanOptions {
  /** Project root. Defaults to the repository root. */
  root?: string;
  /** Realm to scan. Defaults to `main`. */
  realm?: RealmId;
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
  const config = REALMS[realm].scan;
  const {
    compilerOptions,
    aliases,
    root: resolvedRoot,
  } = readProjectTsconfig(root ?? PROJECT_ROOT);
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

  for (const entry of config.hardcoded) {
    const file = path.join(srcRoot, entry.file);
    if (!ts.sys.fileExists(file)) {
      throw new Error(`Hardcoded registry entry ${entry.key} is missing: ${file}`);
    }
    byKey.set(entry.key, file);
  }

  return [...byKey.entries()]
    .map(([key, file]) => ({ key, file }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Read the root `tsconfig.json` `paths` as alias → absolute target pairs. */
export function readAliases(root?: string): Alias[] {
  return readProjectTsconfig(root ?? PROJECT_ROOT).aliases;
}

/** Read the root `tsconfig.json` compiler options. */
export function readCompilerOptions(root?: string): ts.CompilerOptions {
  return readProjectTsconfig(root ?? PROJECT_ROOT).compilerOptions;
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
  return !config.excludedFiles.includes(withoutExtension);
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

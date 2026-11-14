import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  collectRegistryEntries,
  IMPORT_EXTENSIONS,
  readAliases,
  readCompilerOptions,
  type RealmId,
  type RegistryEntry,
} from "../../../scripts/registry-scan.ts";

/**
 * Generate the self-contained `@open-orpheus/plugin-api` type package.
 *
 * This pipeline only produces declarations. Each realm's runtime registry is a
 * separate build-time concern (`plugins/RegistryPlugin.ts`, served as
 * `virtual:open-orpheus/registry[/<realm>]`); the two share only the reader in
 * `scripts/registry-scan.ts`.
 */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const ROOT = path.resolve(PACKAGE_ROOT, "../..");
const DIST = path.join(PACKAGE_ROOT, "dist");

interface RealmBuild {
  id: RealmId;
  /** Contract file rooted in the program. */
  contract: string;
  /** Directory holding `src/**` declarations for this realm. */
  host: string;
  /** Precise `RegistryLoad` map file. */
  registryMap: string;
  /** Package subpath entry point. */
  index: string;
  /** Export lines for `index`. */
  indexExports: string[];
}

const REALM_BUILDS: RealmBuild[] = [
  {
    id: "main",
    contract: path.join(ROOT, "src/main/plugin/types.ts"),
    host: path.join(DIST, "host"),
    registryMap: path.join(DIST, "registry-map.d.ts"),
    index: path.join(DIST, "index.d.ts"),
    indexExports: [
      'export type { PluginModule, PluginRuntime } from "./host/src/main/plugin/types";',
      'export type { PluginRegistry, Registry } from "./host/src/shared/plugin/registry";',
      'export type { RegistryLoad } from "./registry-map";',
    ],
  },
  {
    id: "preload",
    contract: path.join(ROOT, "src/preload/plugin/types.ts"),
    host: path.join(DIST, "preload/host"),
    registryMap: path.join(DIST, "preload/registry-map.d.ts"),
    index: path.join(DIST, "preload/index.d.ts"),
    indexExports: [
      'export type { PreloadPluginModule, PreloadPluginRuntime } from "./host/src/preload/plugin/types";',
      'export type { PluginRegistry, Registry } from "./host/src/shared/plugin/registry";',
      'export type { RegistryLoad } from "./registry-map";',
    ],
  },
];

export function generateApi(): number {
  rmSync(DIST, { recursive: true, force: true });

  let declarations = 0;
  for (const realm of REALM_BUILDS) {
    declarations += generateRealm(realm);
  }

  addDeclarationExtensions(DIST);

  assertKeyvVersion();
  assertVersionConsistency();
  assertConsumable();

  return declarations;
}

function generateRealm(realm: RealmBuild): number {
  const entries = collectRegistryEntries({ root: ROOT, realm: realm.id });

  const compilerOptions: ts.CompilerOptions = {
    ...readCompilerOptions(ROOT),
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    outDir: realm.host,
    rootDir: ROOT,
  };

  const rootNames = [
    path.join(ROOT, "forge.env.d.ts"),
    realm.contract,
    ...entries.map((entry) => entry.file),
  ];

  // Declaration emit can reject exported values whose inferred types mention
  // private symbols. Retry with in-memory annotations for exactly those
  // exports; the source files on disk are never modified.
  const overrides = new Map<string, string>();
  let emitted = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const program = createDeclarationProgram(rootNames, compilerOptions, overrides);
    const emitResult = program.emit();
    const blocking = emitResult.diagnostics.filter((diagnostic) => diagnostic.code !== 4023);
    if (blocking.length > 0) {
      throw new Error(formatDiagnostics(blocking));
    }

    const unnameable = emitResult.diagnostics.filter((diagnostic) => diagnostic.code === 4023);
    if (unnameable.length === 0) {
      emitted = true;
      break;
    }

    if (!annotateUnnameableExports(program, unnameable, overrides)) {
      throw new Error(formatDiagnostics(unnameable));
    }
  }
  if (!emitted) {
    throw new Error("Declaration emit still reports unnameable exported types after retries");
  }

  rewriteAliases(realm.host);
  inlineNativeModules(realm.host);
  writeIfChanged(realm.registryMap, renderRegistryMap(entries, realm));
  patchRegistryDeclaration(realm);
  writeIfChanged(realm.index, renderIndex(realm));
  assertDeclaredDependencies(realm.host);

  return countDeclarations(realm.host);
}

function createDeclarationProgram(
  rootNames: string[],
  options: ts.CompilerOptions,
  overrides: ReadonlyMap<string, string>
): ts.Program {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const override = overrides.get(path.resolve(fileName));
    if (override !== undefined) {
      return ts.createSourceFile(fileName, override, languageVersion, true);
    }
    return getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  return ts.createProgram({ rootNames, options, host });
}

/**
 * Add in-memory type annotations to exported variables whose inferred types
 * reference names the declaration emitter cannot write.
 *
 * The unnameable names come from the TS4023 diagnostics themselves, so this is
 * not specific to any library. Type arguments containing those names are
 * dropped from the end, letting the target type's defaults apply.
 */
function annotateUnnameableExports(
  program: ts.Program,
  diagnostics: readonly ts.Diagnostic[],
  overrides: Map<string, string>
): boolean {
  const checker = program.getTypeChecker();
  const unnameableNames = new Set<string>();
  for (const diagnostic of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    for (const match of message.matchAll(/name '([^']+)'/g)) {
      unnameableNames.add(match[1]);
    }
  }
  if (unnameableNames.size === 0) return false;

  const edits = new Map<string, Map<number, string>>();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.file || diagnostic.start === undefined) continue;
    const sourceFile = diagnostic.file;
    const declaration = findExportedVariableDeclaration(sourceFile, diagnostic.start);
    if (!declaration || declaration.type) continue;

    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration.name);
    const annotation = nameableTypeText(type, declaration, sourceFile, checker, unnameableNames);

    let fileEdits = edits.get(sourceFile.fileName);
    if (!fileEdits) {
      fileEdits = new Map();
      edits.set(sourceFile.fileName, fileEdits);
    }
    fileEdits.set(declaration.name.getEnd(), `: ${annotation}`);
  }
  if (edits.size === 0) return false;

  for (const [fileName, fileEdits] of edits) {
    const key = path.resolve(fileName);
    let text = overrides.get(key) ?? readFileSync(fileName, "utf8");
    const sorted = [...fileEdits.entries()].sort((left, right) => right[0] - left[0]);
    for (const [position, insertion] of sorted) {
      text = `${text.slice(0, position)}${insertion}${text.slice(position)}`;
    }
    overrides.set(key, text);
  }
  return true;
}

function findExportedVariableDeclaration(
  sourceFile: ts.SourceFile,
  position: number
): ts.VariableDeclaration | undefined {
  let result: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (result) return;
    if (ts.isVariableDeclaration(node) && node.name.getStart(sourceFile) === position) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function nameableTypeText(
  type: ts.Type,
  declaration: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  unnameableNames: ReadonlySet<string>
): string {
  const node = checker.typeToTypeNode(
    type,
    declaration,
    ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseFullyQualifiedType
  );
  if (!node) return "unknown";

  const printer = ts.createPrinter();
  const print = (current: ts.Node): string =>
    printer.printNode(ts.EmitHint.Unspecified, current, sourceFile);
  const containsUnnameable = (text: string): boolean =>
    [...unnameableNames].some((name) => text.includes(name));

  if (ts.isTypeReferenceNode(node) && node.typeArguments) {
    const kept: ts.TypeNode[] = [];
    for (const argument of node.typeArguments) {
      if (containsUnnameable(print(argument))) break;
      kept.push(argument);
    }
    const filtered = ts.factory.updateTypeReferenceNode(
      node,
      node.typeName,
      kept.length > 0 ? ts.factory.createNodeArray(kept) : undefined
    );
    const text = print(filtered);
    if (!containsUnnameable(text)) return text;
  }

  const text = print(node);
  return containsUnnameable(text) ? "unknown" : text;
}

function renderRegistryMap(entries: RegistryEntry[], realm: RealmBuild): string {
  const hostRelative = path
    .relative(path.dirname(realm.registryMap), realm.host)
    .split(path.sep)
    .join("/");
  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by packages/plugin-api/scripts/build.ts. Do not edit.");
  lines.push("export declare const load: {");
  for (const entry of entries) {
    const relative = path
      .relative(ROOT, entry.file)
      .split(path.sep)
      .join("/")
      .replace(IMPORT_EXTENSIONS, "");
    lines.push(
      `  readonly ${JSON.stringify(entry.key)}: () => Promise<typeof import("./${hostRelative}/${relative}")>;`
    );
  }
  lines.push("};");
  lines.push("");
  lines.push("export type RegistryLoad = typeof load;");
  lines.push("");
  return lines.join("\n");
}

/**
 * Bind the emitted contract's `RegistryLoad` to the generated precise map.
 *
 * The host source declares a deliberately loose alias (`Record<…>`) so the host
 * can type-check without generation. Plugin authors get the precise map here.
 */
function patchRegistryDeclaration(realm: RealmBuild): void {
  const file = path.join(realm.host, "src", "shared", "plugin", "registry.d.ts");
  const source = readFileSync(file, "utf8");
  const relative = path
    .relative(path.dirname(file), realm.registryMap)
    .split(path.sep)
    .join("/")
    .replace(/\.d\.ts$/, "");
  const patched = source.replace(
    /export type RegistryLoad = [^;]+;/,
    `import type { RegistryLoad } from "${relative}";\nexport type { RegistryLoad };`
  );
  if (patched === source) {
    throw new Error(`Failed to bind the generated RegistryLoad in ${path.relative(ROOT, file)}`);
  }
  writeFileSync(file, patched);
}

function renderIndex(realm: RealmBuild): string {
  return [
    "// AUTO-GENERATED by packages/plugin-api/scripts/build.ts. Do not edit.",
    "// The plugin-facing type surface. Generated from the host; contains no",
    "// references back to the host repository.",
    "",
    ...realm.indexExports,
    "",
  ].join("\n");
}

function rewriteAliases(hostDir: string): void {
  const aliases = readAliases(ROOT);
  const aliasKeys = aliases.map(({ alias }) => alias).sort((a, b) => b.length - a.length);
  const aliasPattern = aliasKeys.map(escapeRegExp).join("|");
  // The lookahead keeps bare `@scope/pkg` specifiers (e.g. `@keyv/sqlite`) from
  // being mistaken for the `@` path alias.
  const fromPattern = new RegExp(`(\\bfrom\\s*)(["'])(${aliasPattern})(?=/|\\2)([^"']*)\\2`, "g");
  const dynamicImportPattern = new RegExp(
    `(\\bimport\\s*\\(\\s*)(["'])(${aliasPattern})(?=/|\\2)([^"']*)\\2`,
    "g"
  );

  for (const file of walk(hostDir)) {
    if (!file.endsWith(".d.ts")) continue;

    const source = readFileSync(file, "utf8");
    const withoutGlobals = stripDeclareGlobal(source);
    const relativeFile = path.relative(hostDir, file);

    const rewrite = (match: string, prefix: string, quote: string, alias: string, rest: string) => {
      const entry = aliases.find((candidate) => candidate.alias === alias);
      if (!entry) return match;
      const target = path.join(entry.target, rest.replace(/\.(?:js|ts)$/, ""));
      const targetRelative = path.relative(ROOT, target);
      if (!existsSync(path.join(hostDir, `${targetRelative}.d.ts`))) {
        throw new Error(
          `Cannot rewrite ${alias}${rest} in ${relativeFile}: missing emitted declaration ${targetRelative}.d.ts`
        );
      }
      const relative = path
        .relative(path.dirname(relativeFile), targetRelative)
        .split(path.sep)
        .join("/");
      const specifier = relative.startsWith(".") ? relative : `./${relative}`;
      return `${prefix}${quote}${specifier}${quote}`;
    };

    const rewritten = withoutGlobals
      .replace(fromPattern, rewrite)
      .replace(dynamicImportPattern, rewrite);

    if (rewritten !== source) writeFileSync(file, rewritten);
  }
}

/**
 * Remove `declare global { ... }` augmentations from emitted declarations.
 *
 * Leaking the host's globals (e.g. `LOGGER`) into a plugin project would collide
 * with the host's own declaration when both are in the same program.
 */
function stripDeclareGlobal(source: string): string {
  let result = source;
  const marker = "declare global";
  let index = result.indexOf(marker);
  while (index !== -1) {
    const braceStart = result.indexOf("{", index);
    if (braceStart === -1) break;
    let depth = 0;
    let end = braceStart;
    for (; end < result.length; end++) {
      const character = result[end];
      if (character === "{") depth++;
      else if (character === "}") {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }
    result = result.slice(0, index) + result.slice(end);
    index = result.indexOf(marker);
  }
  return result;
}

function countDeclarations(directory: string): number {
  let count = 0;
  for (const file of walk(directory)) {
    if (file.endsWith(".d.ts")) count++;
  }
  return count;
}

/**
 * Copy `@open-orpheus/*` declarations into the SDK and rewrite the host tree's
 * imports to relative paths.
 *
 * Those workspace modules are not published, so the SDK cannot depend on them.
 * Their `index.d.ts` files are self-contained (napi-generated), which makes them
 * safe to vendor into `dist/host/_native`.
 */
function inlineNativeModules(hostDir: string): void {
  const compilerOptions = readCompilerOptions(ROOT);
  const nativeDir = path.join(hostDir, "_native");
  const copied = new Map<string, string>();
  const queue: string[] = [];

  const ensureCopied = (specifier: string, containingFile: string): void => {
    if (copied.has(specifier)) return;
    const resolved = ts.resolveModuleName(
      specifier,
      containingFile,
      compilerOptions,
      ts.sys
    ).resolvedModule;
    if (!resolved || !resolved.resolvedFileName.endsWith(".d.ts")) {
      throw new Error(`Cannot resolve the declaration file for ${specifier}`);
    }
    const target = path.join(nativeDir, `${sanitizeSpecifier(specifier)}.d.ts`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(resolved.resolvedFileName));
    copied.set(specifier, target);
    queue.push(target);
  };

  for (const file of walk(hostDir)) {
    if (!file.endsWith(".d.ts")) continue;
    if (path.relative(hostDir, file).startsWith("_native")) continue;
    for (const specifier of nativeSpecifiers(readFileSync(file, "utf8"))) {
      ensureCopied(specifier, file);
    }
  }

  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const specifier of nativeSpecifiers(readFileSync(file, "utf8"))) {
      ensureCopied(specifier, file);
    }
  }

  if (copied.size === 0) return;

  for (const file of walk(hostDir)) {
    if (!file.endsWith(".d.ts")) continue;
    const source = readFileSync(file, "utf8");
    const rewritten = source.replace(
      IMPORT_SPECIFIER_PATTERN,
      (match, prefix, quote, specifier) => {
        const target = copied.get(specifier);
        if (!target) return match;
        const relative = path
          .relative(path.dirname(file), target)
          .split(path.sep)
          .join("/")
          .replace(/\.d\.ts$/, "");
        const spec = relative.startsWith(".") ? relative : `./${relative}`;
        return `${prefix}${quote}${spec}${quote}`;
      }
    );
    if (rewritten !== source) writeFileSync(file, rewritten);
  }
}

function nativeSpecifiers(source: string): string[] {
  return importSpecifiers(source).filter((specifier) => specifier.startsWith("@open-orpheus/"));
}

function sanitizeSpecifier(specifier: string): string {
  return specifier.replace(/^@/, "").replaceAll("/", "__");
}

const IMPORT_SPECIFIER_PATTERN = /(\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\2/g;

/** Bare package specifiers used by a declaration file. */
function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    specifiers.add(match[3]);
  }
  return [...specifiers];
}

/** External (non-relative, non-built-in) package specifiers. */
function externalSpecifiers(source: string): string[] {
  return importSpecifiers(source).filter(
    (specifier) =>
      !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:")
  );
}

/**
 * Fail the build if the emitted declarations reference a package the SDK does
 * not declare.
 *
 * Without this, a host module that starts using a new dependency would silently
 * make the published SDK unresolvable for plugin authors.
 */
function assertDeclaredDependencies(hostDir: string): void {
  const packageJson = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const declared = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
  ]);

  const missing = new Map<string, Set<string>>();
  for (const file of walk(hostDir)) {
    if (!file.endsWith(".d.ts")) continue;
    const source = readFileSync(file, "utf8");
    for (const specifier of externalSpecifiers(source)) {
      if (declared.has(specifier)) continue;
      let files = missing.get(specifier);
      if (!files) missing.set(specifier, (files = new Set()));
      files.add(path.relative(PACKAGE_ROOT, file));
    }
  }

  if (missing.size > 0) {
    const lines = [...missing.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([specifier, files]) => `  ${specifier} (${[...files].sort().join(", ")})`);
    throw new Error(
      "The generated SDK references packages that are not declared in " +
        `packages/plugin-api/package.json:\n${lines.join("\n")}`
    );
  }

  // Declaring the runtime package is not enough when its types live in a
  // separate @types package: an external consumer will not install that
  // package unless it is also a dependency here.
  const missingTypes = new Map<string, Set<string>>();
  for (const file of walk(hostDir)) {
    if (!file.endsWith(".d.ts")) continue;
    const source = readFileSync(file, "utf8");
    for (const specifier of externalSpecifiers(source)) {
      if (!declared.has(specifier) || specifier.startsWith("@types/")) continue;
      if (packageHasTypes(specifier)) continue;
      const typePackage = typesPackageName(specifier);
      if (declared.has(typePackage)) continue;
      let files = missingTypes.get(typePackage);
      if (!files) missingTypes.set(typePackage, (files = new Set()));
      files.add(path.relative(PACKAGE_ROOT, file));
    }
  }

  if (missingTypes.size === 0) return;

  const typeLines = [...missingTypes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([specifier, files]) => `  ${specifier} (${[...files].sort().join(", ")})`);
  throw new Error(
    "The generated SDK references packages whose types live in undeclared @types packages; " +
      `add them to packages/plugin-api/package.json:\n${typeLines.join("\n")}`
  );
}

function packageHasTypes(specifier: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, "node_modules", specifier, "package.json"), "utf8")
    ) as { types?: unknown; typings?: unknown; exports?: unknown };
    if (typeof manifest.types === "string" || typeof manifest.typings === "string") {
      return true;
    }
    return exportsHaveTypes(manifest.exports);
  } catch {
    // If the package is not installed, the runtime declaration check above is
    // the better place to fail.
    return true;
  }
}

function exportsHaveTypes(value: unknown): boolean {
  if (typeof value === "string") return false;
  if (Array.isArray(value)) return value.some(exportsHaveTypes);
  if (value === null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "types" && typeof child === "string") return true;
    if (exportsHaveTypes(child)) return true;
  }
  return false;
}

function typesPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.slice(1).split("/");
    return `@types/${scope}__${name}`;
  }
  return `@types/${specifier.split("/")[0]}`;
}

/**
 * Keep the SDK's `keyv` pin in lockstep with the workspace catalog.
 *
 * `keyv` is a runtime class that crosses the plugin/host boundary (the settings
 * store), so a published SDK must pin the exact version the host uses rather
 * than the workspace-only `catalog:` protocol.
 */
function assertKeyvVersion(): void {
  const packageJson = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const pinned = packageJson.dependencies?.keyv;
  if (typeof pinned !== "string" || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error(
      'packages/plugin-api/package.json must pin an exact keyv version (e.g. "keyv": "6.1.0")'
    );
  }

  const catalog = readCatalogVersion("keyv");
  if (catalog === null) {
    throw new Error("Could not read keyv from the pnpm workspace catalog");
  }
  if (pinned !== catalog) {
    throw new Error(
      `packages/plugin-api/package.json pins keyv ${pinned}, but the workspace catalog uses ` +
        `${catalog}; update the pin`
    );
  }
}

/** Read an entry from the `catalog:` block of `pnpm-workspace.yaml`. */
function readCatalogVersion(name: string): string | null {
  // Git may check this file out with CRLF on Windows; normalize before parsing.
  const source = readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8").replace(
    /\r\n?/g,
    "\n"
  );
  const block = source.match(/^catalog:[ \t]*\n((?:[ \t]+[^\n]*\n?)*)/m)?.[1];
  if (!block) return null;

  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith(`${name}:`)) continue;
    return trimmed
      .slice(name.length + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  }
  return null;
}

/**
 * Add `.js` to relative declaration references.
 *
 * The package is ESM. NodeNext consumers require explicit extensions on
 * relative imports, while the host's compiler options permit extensionless
 * imports during declaration emit.
 */
function addDeclarationExtensions(root: string): void {
  for (const file of walk(root)) {
    if (!file.endsWith(".d.ts")) continue;
    const source = readFileSync(file, "utf8");
    const rewritten = source.replace(
      /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.[^"']+)\2/g,
      (match, prefix: string, quote: string, specifier: string) => {
        if (/\.(?:js|mjs|cjs|json|node)$/.test(specifier)) return match;

        const target = path.resolve(path.dirname(file), specifier);
        if (existsSync(`${target}.d.ts`)) {
          return `${prefix}${quote}${specifier}.js${quote}`;
        }
        if (existsSync(path.join(target, "index.d.ts"))) {
          return `${prefix}${quote}${specifier}/index.js${quote}`;
        }
        return match;
      }
    );
    if (rewritten !== source) writeFileSync(file, rewritten);
  }
}

/**
 * Type-check the packed SDK from outside the repository.
 *
 * A check compiled inside this repo can see hoisted @types packages that an
 * external consumer never installs. Copy the package to a temp directory and
 * link only its declared dependencies, then compile a consumer there.
 */
function assertConsumable(): void {
  const root = mkdtempSync(path.join(tmpdir(), "open-orpheus-plugin-api-"));
  try {
    const packageDir = path.join(root, "node_modules", "@open-orpheus", "plugin-api");
    mkdirSync(packageDir, { recursive: true });
    cpSync(DIST, path.join(packageDir, "dist"), { recursive: true });
    copyFileSync(path.join(PACKAGE_ROOT, "package.json"), path.join(packageDir, "package.json"));

    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const name of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]) {
      const target = path.join(ROOT, "node_modules", name);
      const destination = path.join(root, "node_modules", name);
      mkdirSync(path.dirname(destination), { recursive: true });
      symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
    }

    writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    const consumerPath = path.join(root, "consumer.ts");
    writeFileSync(
      consumerPath,
      [
        'import type * as main from "@open-orpheus/plugin-api";',
        'import type * as preload from "@open-orpheus/plugin-api/preload";',
        "export type Main = typeof main;",
        "export type Preload = typeof preload;",
        "",
      ].join("\n")
    );

    const checks: Array<{ name: string; options: ts.CompilerOptions }> = [
      {
        name: "Bundler",
        options: {
          module: ts.ModuleKind.Preserve,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
      },
      {
        name: "NodeNext",
        options: {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
        },
      },
    ];

    for (const check of checks) {
      const program = ts.createProgram([consumerPath], {
        ...check.options,
        target: ts.ScriptTarget.ESNext,
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        types: ["node"],
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      if (diagnostics.length > 0) {
        throw new Error(
          `Packed plugin API is not consumable outside the repository (${check.name}):\n` +
            formatDiagnostics(diagnostics)
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Keep the SDK version in lockstep with the application version.
 *
 * The SDK is released alongside the host; a mismatch would make it unclear
 * which host a plugin was type-checked against.
 */
function assertVersionConsistency(): void {
  const rootVersion = readPackageVersion(ROOT);
  const apiVersion = readPackageVersion(PACKAGE_ROOT);
  if (rootVersion !== apiVersion) {
    throw new Error(
      `packages/plugin-api/package.json version ${apiVersion} does not match the root ` +
        `project version ${rootVersion}; bump it with the host`
    );
  }
}

function readPackageVersion(directory: string): string {
  const manifestPath = path.join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`Missing version in ${manifestPath}`);
  }
  return manifest.version;
}

function* walk(directory: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => "\n",
  });
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (readFileSync(file, "utf8") === content) return;
  } catch {
    // The file does not exist yet; write it below.
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const declarations = generateApi();
  console.log(`Built @open-orpheus/plugin-api: ${declarations} declaration files (types only)`);
}

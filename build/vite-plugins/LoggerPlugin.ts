import { dirname, relative, resolve } from "node:path";

import { default as MagicString } from "magic-string";
import ts from "typescript";
import { normalizePath, type Plugin } from "vite";

const GLOBAL_NAME = "LOGGER";
// Binding name used for the logger module's default export; the per-file child
// loggers are derived from it.
const BASE_NAME = "_logger";

export interface LoggerPluginOptions {
  /**
   * Path of the logger module to import when a module uses the global
   * `LOGGER`. Accepts an absolute path or a path relative to the project
   * root. Defaults to `src/main/logger.ts`.
   *
   * The directory containing this module is also used as the base for the
   * per-file child logger names (e.g. `cache.ts` -> "cache",
   * `audio/OnlineStreamer.ts` -> "audio/OnlineStreamer").
   */
  logger?: string;
}

/**
 * Vite plugin that turns the compile-time global `LOGGER` into a per-module
 * child logger.
 *
 * For every source module that references the global `LOGGER` identifier, the
 * plugin:
 *
 * 1. Prepends an import of the logger module's default export:
 *    ```ts
 *    import { default as _logger } from "<relative path to the logger module>";
 *    ```
 * 2. Declares a generated, module-scoped child logger right after it, named
 *    after the module's path relative to the logger module's directory (with
 *    the extension stripped):
 *    ```ts
 *    const _logger_a = _logger.child({ name: "cache" });
 *    ```
 * 3. Rewrites every `LOGGER` reference to that generated binding
 *    (e.g. `_logger_a`).
 *
 * For modules inside a `calls/` folder, references that occur inside a
 * `registerCallHandler(cmd, handler)` argument function (at any nesting level)
 * are rewritten to a child of the base logger carrying the command name as its
 * `call` field and a fixed `name` field:
 * ```ts
 * const _logger_b = _logger.child({ name: "call", call: "download.start" });
 * ```
 *
 * References are resolved with the TypeScript compiler API, so only true value
 * references are rewritten. The following are left untouched:
 *
 * - Identifiers inside comments or string literals.
 * - Binding positions: declaration names, destructuring bindings, parameters,
 *   import/export specifiers, labels and property names.
 * - Member accesses such as `foo.LOGGER` (only the expression side is a
 *   reference to the global).
 * - Type positions, with the exception of `typeof LOGGER`, which refers to the
 *   value and is rewritten as well.
 * - References shadowed by a local `LOGGER` declaration in any enclosing scope.
 */
export default function LoggerPlugin(
  options: LoggerPluginOptions = {}
): Plugin {
  const loggerPath = normalizePath(
    resolve(process.cwd(), options.logger ?? "src/main/logger.ts")
  );
  // Child logger names are the module path relative to the logger's directory.
  const childNameBase = dirname(loggerPath);

  return {
    name: "logger",

    transform(code, id) {
      if (!canTransform(id)) return null;
      // Cheap early exit before handing the code to the TypeScript parser.
      if (!code.includes(GLOBAL_NAME)) return null;
      if (id === loggerPath) return null;

      const inCallsFolder = isInCallsFolder(id, childNameBase);
      const references = findGlobalLoggerReferences(id, code);
      if (references.length === 0) return null;

      // In `calls/` folder modules, references inside a `registerCallHandler`
      // handler become their own child of the base logger
      // (`_logger.child({ name: "call", call })`). Everything else uses the
      // per-file child logger.
      const callRefs: LoggerReference[] = [];
      const fileRefs: LoggerReference[] = [];
      for (const ref of references) {
        if (inCallsFolder && ref.call) callRefs.push(ref);
        else fileRefs.push(ref);
      }
      const calls = new Set(callRefs.map((ref) => ref.call!));

      // Generate module-scoped bindings that do not collide with anything
      // already present in the module, e.g. `_logger_a`, `_logger_b`, ...
      const nextBinding = createBindingGenerator(code);
      const fileBinding = fileRefs.length > 0 ? nextBinding() : undefined;
      const callBindings = new Map<string, string>();
      for (const call of calls) callBindings.set(call, nextBinding());

      const s = new MagicString(code);
      for (const ref of references) {
        const binding =
          ref.call && callBindings.has(ref.call)
            ? callBindings.get(ref.call)!
            : fileBinding!;
        s.overwrite(ref.start, ref.end, binding);
      }

      const importPath = toImportPath(id, loggerPath);
      const childName = toChildName(id, childNameBase);
      let injection = `import { default as ${BASE_NAME} } from ${JSON.stringify(importPath)};\n`;
      if (fileBinding) {
        injection += `const ${fileBinding} = ${BASE_NAME}.child({ name: ${JSON.stringify(childName)} });\n`;
      }
      for (const call of calls) {
        injection += `const ${callBindings.get(call)} = ${BASE_NAME}.child({ name: "call", call: ${JSON.stringify(call)} });\n`;
      }
      s.prepend(injection);

      return {
        code: s.toString(),
        map: s.generateMap({ hires: true, source: id, includeContent: true }),
      };
    },
  };
}

const transformableExt = /\.(?:[cm]?[jt]sx?)$/;

function canTransform(id: string): boolean {
  if (id.startsWith("\0")) return false; // Vite virtual module
  if (id.includes("node_modules")) return false;
  if (id.endsWith(".d.ts")) return false;
  return transformableExt.test(id);
}

function toImportPath(fromFile: string, toFile: string): string {
  let importPath = relative(dirname(fromFile), toFile).replaceAll("\\", "/");
  if (!importPath.startsWith(".")) importPath = `./${importPath}`;
  return importPath;
}

/**
 * Create a generator for module-scoped binding names (e.g. `_logger_a`,
 * `_logger_b`, ...) that never returns a name already present in the module
 * source or previously generated.
 */
function createBindingGenerator(code: string): () => string {
  const used = new Set<string>();
  for (const match of code.matchAll(/\b_logger_[a-z]+\b/g)) used.add(match[0]);
  let index = 0;
  return () => {
    let candidate: string;
    do {
      candidate = `${BASE_NAME}_${columnSuffix(index++)}`;
    } while (used.has(candidate));
    used.add(candidate);
    return candidate;
  };
}

/**
 * Whether the module lives inside the `calls` folder, i.e. its path relative
 * to the logger module's directory starts with `calls/`.
 */
function isInCallsFolder(id: string, baseDir: string): boolean {
  return relative(baseDir, id).replaceAll("\\", "/").split("/")[0] === "calls";
}

/** 0 -> "a", 25 -> "z", 26 -> "aa", 27 -> "ab", ... */
function columnSuffix(index: number): string {
  let result = "";
  index += 1;
  while (index > 0) {
    const remainder = (index - 1) % 26;
    result = String.fromCharCode(97 + remainder) + result;
    index = Math.floor((index - 1) / 26);
  }
  return result;
}

/**
 * Derive the pino child logger `name` from the module path: the path relative
 * to the logger module's directory with the file extension stripped, e.g.
 * `cache.ts` -> "cache", `audio/OnlineStreamer.ts` -> "audio/OnlineStreamer".
 */
function toChildName(id: string, baseDir: string): string {
  const withoutExt = relative(baseDir, id).replace(
    /\.(?:[cm]?[jt]sx?|d\.ts)$/,
    ""
  );
  return withoutExt.replaceAll("\\", "/");
}

interface LoggerReference {
  start: number;
  end: number;
  /**
   * The `registerCallHandler` command name when the reference is inside that
   * call's handler function, otherwise `undefined`.
   */
  call?: string;
}

interface CallHandler {
  /** Source range of the handler function passed to `registerCallHandler`. */
  start: number;
  end: number;
  /** Value of the first argument (the command string), if it is a literal. */
  call?: string;
}

/** True for inline handler functions (arrow functions / function expressions). */
function isHandlerFunction(node: ts.Node): boolean {
  return (
    node.kind === ts.SyntaxKind.ArrowFunction ||
    node.kind === ts.SyntaxKind.FunctionExpression
  );
}

/**
 * Collect every handler function passed to a `registerCallHandler(...)` call,
 * together with the command name from its first argument.
 */
function collectCallHandlers(sourceFile: ts.SourceFile): CallHandler[] {
  const handlers: CallHandler[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "registerCallHandler"
    ) {
      const first = node.arguments[0];
      const call =
        first && first.kind === ts.SyntaxKind.StringLiteral
          ? (first as ts.StringLiteral).text
          : undefined;
      for (const arg of node.arguments) {
        if (isHandlerFunction(arg)) {
          handlers.push({
            start: arg.getStart(sourceFile),
            end: arg.getEnd(),
            call,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return handlers;
}

/**
 * Return the `call` name of the innermost `registerCallHandler` handler that
 * contains the given source range, or `undefined` when not inside one.
 */
function findEnclosingCall(
  start: number,
  end: number,
  handlers: CallHandler[]
): string | undefined {
  let best: CallHandler | undefined;
  for (const handler of handlers) {
    if (start >= handler.start && end <= handler.end) {
      if (!best || handler.end - handler.start < best.end - best.start) {
        best = handler;
      }
    }
  }
  return best?.call;
}

/**
 * Find the source ranges of every `LOGGER` identifier that is an unshadowed
 * value reference to the global (as opposed to a binding, a property/member
 * name, a type position or a locally declared variable).
 */
function findGlobalLoggerReferences(
  fileName: string,
  code: string
): LoggerReference[] {
  const scriptKind = /\.(?:[cm]?[jt]sx)$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.(?:[cm]?[jt]s)$/.test(fileName)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;

  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind
  );

  const references: LoggerReference[] = [];
  const handlers = collectCallHandlers(sourceFile);
  // Lexical scope stack. Each entry holds the identifiers declared as LOGGER
  // within that scope. A reference is only treated as the global when no
  // enclosing scope declares LOGGER itself (i.e. it is not shadowed).
  const scopes: ts.Identifier[][] = [[]];

  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      if (name.text === GLOBAL_NAME) scopes[scopes.length - 1].push(name);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) bind(element.name);
    }
  };

  const isShadowed = (): boolean => scopes.some((scope) => scope.length > 0);

  // True when `id` is a binding/declaration site rather than a value reference
  // to the global (declaration names, property names, import/export specifiers,
  // member accesses, labels, type positions, ...).
  const isBindingSite = (
    id: ts.Identifier,
    parent: ts.Node | undefined
  ): boolean => {
    if (!parent) return false;
    if (ts.isVariableDeclaration(parent) && parent.name === id) return true;
    if (ts.isParameter(parent) && parent.name === id) return true;
    if (ts.isBindingElement(parent) && parent.name === id) return true;
    if (ts.isCatchClause(parent) && parent.variableDeclaration?.name === id)
      return true;
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent)) &&
      parent.name === id
    )
      return true;
    if (ts.isPropertyAssignment(parent) && parent.name === id) return true;
    if (ts.isShorthandPropertyAssignment(parent)) return true; // { LOGGER }
    if (
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isExportSpecifier(parent)
    )
      return true;
    if (ts.isLabeledStatement(parent) && parent.label === id) return true;
    if (ts.isPropertySignature(parent) && parent.name === id) return true;
    if (ts.isPropertyDeclaration(parent) && parent.name === id) return true;
    if (ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent))
      return parent.name === id;
    if (
      ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAccessChain(parent)
    )
      return parent.name === id; // `x.LOGGER` is a member, not the global
    if (ts.isQualifiedName(parent)) return parent.right === id;
    if (ts.isTypeParameterDeclaration(parent)) return true;
    if (parent.kind === ts.SyntaxKind.TypeQuery) return false; // `typeof LOGGER` refers to the value
    if (ts.isTypeNode(parent)) return true;
    return false;
  };

  const isScopeNode = (node: ts.Node): boolean =>
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    (ts.isFunctionLike(node) &&
      !ts.isFunctionTypeNode(node) &&
      !ts.isConstructorTypeNode(node));

  const visit = (
    node: ts.Node,
    parent: ts.Node | undefined,
    inType: boolean
  ): void => {
    const createsScope = isScopeNode(node);
    const typeContext = inType || ts.isTypeNode(node);

    if (createsScope) {
      // Function/class names are bound in the *enclosing* scope.
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node)) &&
        node.name
      ) {
        bind(node.name);
      }
      scopes.push([]);
      // The catch parameter is bound inside the catch clause's own scope.
      if (ts.isCatchClause(node) && node.variableDeclaration) {
        bind(node.variableDeclaration.name);
      }
    } else if (ts.isVariableDeclaration(node)) {
      bind(node.name);
    } else if (ts.isParameter(node)) {
      bind(node.name);
    } else if (ts.isImportClause(node) && node.name) {
      bind(node.name);
    } else if (ts.isNamespaceImport(node)) {
      bind(node.name);
    } else if (ts.isImportSpecifier(node)) {
      bind(node.name);
    } else if (ts.isImportEqualsDeclaration(node) && node.name) {
      bind(node.name);
    }

    if (ts.isIdentifier(node) && node.text === GLOBAL_NAME) {
      const inTypeQuery = parent?.kind === ts.SyntaxKind.TypeQuery;
      const isGlobalReference =
        !isBindingSite(node, parent) &&
        (!typeContext || inTypeQuery) &&
        !isShadowed();
      if (isGlobalReference) {
        const start = node.getStart(sourceFile);
        const end = node.getEnd();
        references.push({
          start,
          end,
          call: findEnclosingCall(start, end, handlers),
        });
      }
    }

    ts.forEachChild(node, (child) => visit(child, node, typeContext));

    if (createsScope) scopes.pop();
  };

  visit(sourceFile, undefined, false);
  return references;
}

import ts from "typescript";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Rewrites only specifiers that no longer resolve, by searching the known roots.
const GROUPS = [
  "ipc/handlers",
  "windows/menu",
  "bootstrap/services",
  "services",
  "platform",
  "domain",
  "windows",
  "ipc",
  "bootstrap",
  "",
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.posix.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const resolves = (p) =>
  existsSync(p) || existsSync(p + ".ts") || existsSync(p + "/index.ts");

function candidates(stripped) {
  const out = [];
  const variants = [stripped];
  for (const g of GROUPS) {
    if (g && stripped.startsWith(g + "/")) variants.push(stripped.slice(g.length + 1));
  }
  for (const v of variants) {
    for (const h of GROUPS) out.push(h ? `src/main/${h}/${v}` : `src/main/${v}`);
    out.push(`__test__/${v}`, `__test__/main/${v}`, `src/${v}`, v);
  }
  return out;
}

function tryResolve(spec, fromFile) {
  if (!spec.startsWith(".")) return null;
  const t = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  for (const cand of [t, t + ".ts", t + "/index.ts"]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

const stripExt = (p) => p.replace(/\.ts$/, "").replace(/\/index$/, "");

let rewritten = 0;
const unresolved = [];

for (const file of [...walk("src"), ...walk("__test__")]) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [];

  const visit = (node) => {
    let spec = null;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      spec = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      spec = node.arguments[0];
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      spec = node.argument.literal;
    }
    if (spec) {
      const text = spec.text;
      let next = null;
      if (text.startsWith(".") && !tryResolve(text, file)) {
        const stripped = text.replace(/^(\.\.?\/)+/, "");
        const found = candidates(stripped).find(resolves);
        if (found) {
          const r = path.posix.relative(path.posix.dirname(file), stripExt(found));
          next = r.startsWith(".") ? r : "./" + r;
        } else unresolved.push(`${file}: ${text}`);
      } else if (text.startsWith("@main/") && !resolves("src/main/" + text.slice(6))) {
        const found = candidates(text.slice(6)).find(resolves);
        if (found) next = "@main/" + stripExt(found).slice("src/main/".length);
        else unresolved.push(`${file}: ${text}`);
      }
      if (next !== null && next !== text)
        edits.push([spec.getStart(sf) + 1, spec.getEnd() - 1, next]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (edits.length) {
    let out = src;
    for (const [start, end, next] of edits.sort((a, b) => b[0] - a[0])) {
      out = out.slice(0, start) + next + out.slice(end);
    }
    writeFileSync(file, out);
    rewritten++;
  }
}

console.log(`rewrote ${rewritten} files`);
if (unresolved.length) {
  console.log("UNRESOLVED:");
  for (const u of unresolved) console.log("  " + u);
}

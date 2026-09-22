import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const callsDir = fileURLToPath(
  new URL("../../../src/main/calls/", import.meta.url)
);

const modules = readdirSync(callsDir)
  .filter((name) => name.endsWith(".ts") && name !== "index.ts")
  .map((name) => name.slice(0, -".ts".length));

function source(name: string) {
  return readFileSync(`${callsDir}${name}.ts`, "utf8");
}

describe("call module barrel", () => {
  it("finds the call modules", () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  it("imports every module in src/main/calls", () => {
    const barrel = readFileSync(`${callsDir}index.ts`, "utf8");
    const missing = modules.filter((name) => !barrel.includes(`"./${name}"`));
    expect(missing).toEqual([]);
  });

  it("exports register() from every module", () => {
    const missing = modules.filter(
      (name) => !/^export function register\(/m.test(source(name))
    );
    expect(missing).toEqual([]);
  });

  it("registers nothing at import time", () => {
    const offenders = modules.filter((name) =>
      /^register(Call|Callback)Handler/m.test(source(name))
    );
    expect(offenders).toEqual([]);
  });
});

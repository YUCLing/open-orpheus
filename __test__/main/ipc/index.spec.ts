import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ipcDir = fileURLToPath(
  new URL("../../../src/main/ipc/", import.meta.url)
);

const modules = readdirSync(ipcDir)
  .filter(
    (name) =>
      name.endsWith(".ts") && name !== "index.ts" && name !== "dispatcher.ts"
  )
  .map((name) => name.slice(0, -".ts".length));

function source(name: string) {
  return readFileSync(`${ipcDir}${name}.ts`, "utf8");
}

describe("ipc module barrel", () => {
  it("finds the call modules", () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  it("imports every module in src/main/ipc", () => {
    const barrel = readFileSync(`${ipcDir}index.ts`, "utf8");
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

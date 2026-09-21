import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const callsDir = fileURLToPath(
  new URL("../../../src/main/calls/", import.meta.url)
);

describe("call module barrel", () => {
  it("imports every module in src/main/calls", () => {
    const barrel = readFileSync(`${callsDir}index.ts`, "utf8");
    const onDisk = readdirSync(callsDir)
      .filter((name) => name.endsWith(".ts") && name !== "index.ts")
      .map((name) => name.slice(0, -".ts".length));

    expect(onDisk.length).toBeGreaterThan(0);

    const missing = onDisk.filter((name) => !barrel.includes(`"./${name}"`));
    expect(missing).toEqual([]);
  });
});

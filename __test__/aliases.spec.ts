import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import tsconfig from "../tsconfig.json";
import vitestConfig from "../vitest.config";

const root = fileURLToPath(new URL("..", import.meta.url));

const aliases = (vitestConfig.resolve?.alias ?? {}) as unknown as Record<
  string,
  string
>;
const paths = (tsconfig.compilerOptions.paths ?? {}) as unknown as Record<
  string,
  string[]
>;

function withoutGlob(specifier: string) {
  return specifier.replace(/\/\*$/, "");
}

describe("path aliases", () => {
  it("both alias sets are non-empty", () => {
    expect(Object.keys(paths).length).toBeGreaterThan(0);
    expect(Object.keys(aliases).length).toBeGreaterThan(0);
  });

  it("vitest.config.ts declares every tsconfig.json path alias", () => {
    for (const [specifier, targets] of Object.entries(paths)) {
      const alias = withoutGlob(specifier);
      expect(
        aliases[alias],
        `vitest.config.ts has no alias for ${specifier}`
      ).toBeDefined();
      expect(
        path.normalize(aliases[alias]),
        `${alias} resolves somewhere other than tsconfig.json says`
      ).toBe(path.resolve(root, withoutGlob(targets[0])));
    }
  });

  it("vitest.config.ts declares no alias that tsconfig.json lacks", () => {
    const declared = new Set(Object.keys(paths).map(withoutGlob));
    for (const alias of Object.keys(aliases)) {
      expect(
        declared,
        `vitest.config.ts aliases ${alias}, which tsconfig.json does not declare`
      ).toContain(alias);
    }
  });
});

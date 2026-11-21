import { describe, expect, it } from "vitest";

import { collectRegistryEntries } from "../../../scripts/registry-scan";

describe("collectRegistryEntries", () => {
  it("derives keys from the root tsconfig aliases", () => {
    const entries = collectRegistryEntries();
    const keys = entries.map((entry) => entry.key);

    expect(keys).toContain("@main/lifecycle");
    expect(keys).toContain("@main/playback/adapters/MprisAdapter");
    expect(keys).toContain("@/constants");
  });

  it("includes hardcoded preload surface entries", () => {
    const keys = collectRegistryEntries({ realm: "preload" }).map((entry) => entry.key);

    expect(keys).toContain("@preload/logger");
  });

  it("excludes the plugin framework itself", () => {
    const keys = collectRegistryEntries().map((entry) => entry.key);

    expect(keys.some((key) => key.startsWith("@main/plugin/"))).toBe(false);
  });
});

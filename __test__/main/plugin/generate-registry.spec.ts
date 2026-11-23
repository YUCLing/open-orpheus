import { describe, expect, it } from "vitest";

import { collectRegistryEntries } from "../../../tools/registry/scan";
import { REALMS, REALM_IDS } from "../../../tools/config/realms";

describe("collectRegistryEntries", () => {
  it("derives keys from the root tsconfig aliases", () => {
    const entries = collectRegistryEntries();
    const keys = entries.map((entry) => entry.key);

    expect(keys).toContain("@main/lifecycle");
    expect(keys).toContain("@main/playback/adapters/MprisAdapter");
    expect(keys).toContain("@/constants");
  });

  it("defines every registry realm exactly once", () => {
    expect(REALM_IDS).toEqual(expect.arrayContaining(["main", "preload", "plugin-manager"]));
    expect(new Set(REALM_IDS.map((realm) => REALMS[realm].virtualId)).size).toBe(REALM_IDS.length);
  });

  it("includes hardcoded preload surface entries", () => {
    const keys = collectRegistryEntries({ realm: "preload" }).map((entry) => entry.key);

    expect(keys).toContain("@preload/logger");
  });

  it("excludes the plugin framework from the plugin-manager realm", () => {
    const keys = collectRegistryEntries({ realm: "plugin-manager" }).map((entry) => entry.key);

    expect(keys).toContain("@preload/bridge");
    expect(keys).toContain("@preload/logger");
    expect(keys).toContain("@preload/util");
    expect(keys.some((key) => key.startsWith("@preload/plugin/"))).toBe(false);
  });

  it("excludes the plugin framework itself", () => {
    const keys = collectRegistryEntries().map((entry) => entry.key);

    expect(keys.some((key) => key.startsWith("@main/plugin/"))).toBe(false);
  });
});

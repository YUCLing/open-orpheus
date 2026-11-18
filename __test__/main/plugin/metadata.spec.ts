import { describe, expect, it } from "vitest";

import { parsePluginMetadata } from "../../../src/main/plugin/metadata";

const valid = {
  id: "org.example.nowplaying",
  name: "Now Playing",
  version: "1.0.0",
  realms: { main: "main/index.mjs" },
};

describe("parsePluginMetadata", () => {
  it("parses a valid metadata object", () => {
    const metadata = parsePluginMetadata(valid, "test");
    expect(metadata.id).toBe("org.example.nowplaying");
    expect(metadata.realms.main).toBe("main/index.mjs");
  });

  it("requires an .mjs main entry", () => {
    expect(() =>
      parsePluginMetadata({ ...valid, realms: { main: "main/index.js" } }, "test")
    ).toThrow(/\.mjs/);
  });

  it("rejects path traversal in realm paths", () => {
    expect(() =>
      parsePluginMetadata({ ...valid, realms: { main: "../evil.mjs" } }, "test")
    ).toThrow(/inside the plugin directory/);
  });

  it("rejects absolute realm paths", () => {
    expect(() =>
      parsePluginMetadata({ ...valid, realms: { main: "/etc/evil.mjs" } }, "test")
    ).toThrow(/inside the plugin directory/);
  });

  it("rejects an invalid id", () => {
    expect(() => parsePluginMetadata({ ...valid, id: "../evil" }, "test")).toThrow(
      /must start with a letter or digit/
    );
  });

  it("rejects a missing name", () => {
    expect(() => parsePluginMetadata({ ...valid, name: undefined }, "test")).toThrow(/name/);
  });

  it("accepts a preload realm with a .cjs entry", () => {
    const metadata = parsePluginMetadata(
      {
        ...valid,
        realms: { main: "main/index.mjs", preload: "preload/index.cjs" },
      },
      "test"
    );
    expect(metadata.realms.preload).toBe("preload/index.cjs");
  });

  it("rejects a preload realm that is not .cjs", () => {
    expect(() =>
      parsePluginMetadata(
        {
          ...valid,
          realms: { main: "main/index.mjs", preload: "preload/index.mjs" },
        },
        "test"
      )
    ).toThrow(/\.cjs/);
  });

  it("accepts an icon relative to the assets directory", () => {
    const metadata = parsePluginMetadata({ ...valid, icon: "icons/plugin.png" }, "test");
    expect(metadata.icon).toBe("icons/plugin.png");
  });

  it("rejects an icon escaping the assets directory", () => {
    expect(() => parsePluginMetadata({ ...valid, icon: "../metadata.json" }, "test")).toThrow(
      /assets directory/
    );
  });

  it("rejects an absolute icon path", () => {
    expect(() => parsePluginMetadata({ ...valid, icon: "/icon.png" }, "test")).toThrow(
      /assets directory/
    );
  });
});

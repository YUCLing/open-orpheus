import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => (await import("memfs")).fs.promises);

import { vol } from "memfs";

import { writeIcons } from "../../packaging/common/icons";

describe("writeIcons", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("writes raster icons to $size/apps/$appName.$ext", async () => {
    vol.fromJSON({
      "assets/icon_256.png": "fake-png-256",
      "assets/icon_512.png": "fake-png-512",
    });

    await writeIcons("/usr/share/icons/hicolor", "open-orpheus", {
      "256x256": "assets/icon_256.png",
      "512x512": "assets/icon_512.png",
    });

    expect(vol.toSnapshot()).toMatchSnapshot();
  });

  it("writes scalable icons to scalable/apps/$appName.svg", async () => {
    vol.fromJSON({ "assets/icon.svg": "<svg></svg>" });

    await writeIcons("/usr/share/icons/hicolor", "open-orpheus", {
      scalable: "assets/icon.svg",
    });

    expect(vol.toSnapshot()).toMatchSnapshot();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { readFile } from "node:fs/promises";

import { vol } from "memfs";

import { writeIcons } from "../../packaging/common/icons";

/**
 * Fixtures use absolute paths on purpose: memfs anchors relative paths at
 * `process.cwd()`, which would leak the checkout directory into the volume and
 * make assertions (and snapshots) depend on where the repo happens to live.
 */
const FIXTURES = "/fixtures";
const ICONS_DIR = "/usr/share/icons/hicolor";

const read = (path: string) => readFile(path, "utf-8");

describe("writeIcons", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("writes raster icons to $size/apps/$appName.$ext", async () => {
    vol.fromJSON({
      [`${FIXTURES}/icon_256.png`]: "fake-png-256",
      [`${FIXTURES}/icon_512.png`]: "fake-png-512",
    });

    await writeIcons(ICONS_DIR, "open-orpheus", {
      "256x256": `${FIXTURES}/icon_256.png`,
      "512x512": `${FIXTURES}/icon_512.png`,
    });

    // Only the requested sizes are created, with the source extension.
    expect(vol.toSnapshot()).toMatchSnapshot();
  });

  it("writes scalable icons to scalable/apps/$appName.svg", async () => {
    vol.fromJSON({ [`${FIXTURES}/icon.svg`]: "<svg></svg>" });

    await writeIcons(ICONS_DIR, "open-orpheus", {
      scalable: `${FIXTURES}/icon.svg`,
    });

    expect(vol.toSnapshot()).toMatchSnapshot();
  });

  it("keeps the extension of the source file", async () => {
    vol.fromJSON({ [`${FIXTURES}/icon.ico`]: "fake-ico" });

    await writeIcons(ICONS_DIR, "my-app", {
      "256x256": `${FIXTURES}/icon.ico`,
    });

    expect(vol.toSnapshot()).toMatchSnapshot();
  });

  it("skips sizes without a source file", async () => {
    vol.fromJSON({ [`${FIXTURES}/icon_256.png`]: "fake-png-256" });

    await writeIcons(ICONS_DIR, "open-orpheus", {
      "128x128": undefined,
      "256x256": `${FIXTURES}/icon_256.png`,
    });

    expect(vol.toSnapshot()).toMatchSnapshot();
  });

  it("leaves the source fixtures untouched", async () => {
    vol.fromJSON({ [`${FIXTURES}/icon_256.png`]: "fake-png-256" });

    await writeIcons(ICONS_DIR, "open-orpheus", {
      "256x256": `${FIXTURES}/icon_256.png`,
    });

    await expect(read(`${FIXTURES}/icon_256.png`)).resolves.toBe("fake-png-256");
  });
});

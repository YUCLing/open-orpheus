import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { vol } from "memfs";

import { createPrebuiltBundle, resolvePrebuiltAppDir } from "../../tools/packaging/common/prebuilt";

const REPO = resolve("repo");
const OUT = join(REPO, "out");
const STAGE = resolve("stage", "prebuilt");
const prebuilt = (name: string) => join(OUT, name);

/** The icons the shared packaging metadata installs, at their project-relative paths. */
const METADATA_ICONS = {
  [join(REPO, "assets", "icon_256.png")]: "256",
  [join(REPO, "assets", "icon_512.png")]: "512",
  [join(REPO, "assets", "icon.svg")]: "<svg />",
};

beforeEach(() => {
  vol.reset();
  // memfs starts empty; `mkdtemp` needs its parent and the metadata icons
  // must be readable through the mocked `fs/promises`.
  vol.fromJSON({
    ...METADATA_ICONS,
  });
  vol.mkdirSync(tmpdir(), { recursive: true });
});

describe("resolvePrebuiltAppDir", () => {
  it("finds the packaged app for the requested arch", async () => {
    vol.fromJSON({
      [join(prebuilt("open-orpheus-linux-arm64"), "resources", "app.asar")]: "app",
    });

    await expect(resolvePrebuiltAppDir(REPO, "open-orpheus", "arm64")).resolves.toBe(
      prebuilt("open-orpheus-linux-arm64")
    );
  });

  it("falls back to the host arch", async () => {
    vol.fromJSON({
      [join(prebuilt(`open-orpheus-linux-${process.arch}`), "resources", "app.asar")]: "app",
    });

    await expect(resolvePrebuiltAppDir(REPO, "open-orpheus")).resolves.toBe(
      prebuilt(`open-orpheus-linux-${process.arch}`)
    );
  });

  it("looks only at the requested arch when one is given", async () => {
    // Must differ from the host arch, or the "requested" arch would match the
    // directory that exists and the assertion would fail on that host.
    const otherArch = process.arch === "arm64" ? "x64" : "arm64";
    vol.fromJSON({
      [join(prebuilt(`open-orpheus-linux-${process.arch}`), "resources", "app.asar")]: "app",
    });

    await expect(resolvePrebuiltAppDir(REPO, "open-orpheus", otherArch)).rejects.toThrow(
      /No packaged Electron app found/
    );
  });

  it("explains how to produce the directory when it is missing", async () => {
    await expect(resolvePrebuiltAppDir(REPO, "open-orpheus")).rejects.toThrow(
      "Run `pnpm package` first."
    );
  });
});

describe.runIf(process.platform !== "win32")("createPrebuiltBundle", () => {
  it("stages the app and generates the scaffold", async () => {
    vol.fromJSON({
      [join(OUT, "open-orpheus-linux-x64", "open-orpheus")]: "binary",
      [join(OUT, "open-orpheus-linux-x64", "resources", "app.asar")]: "asar",
    });

    const dest = await createPrebuiltBundle(
      REPO,
      join(OUT, "open-orpheus-linux-x64"),
      "open-orpheus",
      STAGE
    );

    expect(dest).toBe(STAGE);
    expect(vol.existsSync(join(STAGE, "app", "open-orpheus"))).toBe(true);
    expect(vol.existsSync(join(STAGE, "app", "resources", "app.asar"))).toBe(true);
    expect(vol.existsSync(join(STAGE, "scaffold", "usr", "share", "applications"))).toBe(true);
    expect(
      vol.existsSync(
        join(STAGE, "scaffold", "usr", "share", "applications", "open-orpheus.desktop")
      )
    ).toBe(true);
    expect(
      vol.existsSync(join(STAGE, "scaffold", "usr", "share", "icons", "hicolor", "256x256", "apps"))
    ).toBe(true);
    const binLink = join(STAGE, "scaffold", "usr", "bin", "open-orpheus");
    expect(vol.lstatSync(binLink).isSymbolicLink()).toBe(true);
    expect(vol.readlinkSync(binLink)).toBe("../lib/open-orpheus/open-orpheus");
  });

  it("replaces an existing bundle", async () => {
    vol.fromJSON({
      [join(OUT, "app-linux-x64", "app")]: "binary",
      [join(STAGE, "app", "stale")]: "old",
      [join(STAGE, "keep.txt")]: "old",
    });

    await createPrebuiltBundle(REPO, join(OUT, "app-linux-x64"), "app", STAGE);

    expect(vol.existsSync(join(STAGE, "app", "stale"))).toBe(false);
    expect(vol.existsSync(join(STAGE, "keep.txt"))).toBe(false);
    expect(vol.existsSync(join(STAGE, "app", "app"))).toBe(true);
  });
});

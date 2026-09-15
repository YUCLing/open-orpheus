import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { readFile } from "node:fs/promises";

import { vol } from "memfs";
import yaml from "yaml";

import {
  baseManifest,
  DESKTOP_EXEC,
  prebuiltAppModule,
  writeManifest,
  type ManifestContext,
} from "../../packaging/flatpak/manifest";

const ctx: ManifestContext = {
  appId: "io.github.yucling.open-orpheus",
  appIdentifier: "open-orpheus",
  runtimeVersion: "25.08",
  baseVersion: "25.08",
  finishArgs: ["--socket=wayland", "--share=network"],
};

const appModule = { name: "open-orpheus", buildsystem: "simple" };

describe("baseManifest", () => {
  it("assembles the runtime, base and app module", () => {
    expect(baseManifest(ctx, appModule)).toEqual({
      "app-id": "io.github.yucling.open-orpheus",
      runtime: "org.freedesktop.Platform",
      "runtime-version": "25.08",
      sdk: "org.freedesktop.Sdk",
      base: "org.electronjs.Electron2.BaseApp",
      "base-version": "25.08",
      command: DESKTOP_EXEC,
      "separate-locales": false,
      "finish-args": ["--socket=wayland", "--share=network"],
      "sdk-extensions": ["org.freedesktop.Sdk.Extension.node24"],
      modules: [appModule],
    });
  });

  it("launches through the zypak wrapper", () => {
    expect(baseManifest(ctx, appModule).command).toBe("electron-wrapper");
  });

  it("adds a branch only when one is given", () => {
    expect(baseManifest({ ...ctx, branch: "stable" }, appModule).branch).toBe(
      "stable"
    );
    expect(baseManifest(ctx, appModule)).not.toHaveProperty("branch");
  });

  it("omits sdk-extensions when the build needs none", () => {
    const manifest = baseManifest({ ...ctx, sdkExtensions: [] }, appModule);

    expect(manifest).not.toHaveProperty("sdk-extensions");
  });

  it("honours an explicit extension list", () => {
    const manifest = baseManifest(
      { ...ctx, sdkExtensions: ["org.freedesktop.Sdk.Extension.node24", "x"] },
      appModule
    );

    expect(manifest["sdk-extensions"]).toEqual([
      "org.freedesktop.Sdk.Extension.node24",
      "x",
    ]);
  });

  it("appends the app module after extra modules", () => {
    const extra = { name: "ffmpeg" };
    const manifest = baseManifest({ ...ctx, extraModules: [extra] }, appModule);

    expect(manifest.modules).toEqual([extra, appModule]);
  });
});

describe("prebuiltAppModule", () => {
  it("copies the bundled payload and scaffold into /app", () => {
    expect(
      prebuiltAppModule(ctx, {
        appBundle: "open-orpheus-linux-x64.tar.gz",
        metainfo: "io.github.yucling.open-orpheus.metainfo.xml",
      })
    ).toEqual({
      name: "open-orpheus",
      buildsystem: "simple",
      "build-commands": [
        "cp -r scaffold/. /app/",
        "install -d /app/lib/open-orpheus",
        "cp -r app/. /app/lib/open-orpheus/",
        "install -Dm644 io.github.yucling.open-orpheus.metainfo.xml /app/share/metainfo/io.github.yucling.open-orpheus.metainfo.xml",
      ],
      sources: [{ type: "archive", path: "open-orpheus-linux-x64.tar.gz" }],
    });
  });

  it("follows the app identifier and id from the context", () => {
    const module = prebuiltAppModule(
      { ...ctx, appId: "io.github.other.app", appIdentifier: "other" },
      { appBundle: "other.tar.gz", metainfo: "m.xml" }
    );

    expect(module.name).toBe("other");
    expect(module["build-commands"]).toContain("install -d /app/lib/other");
    expect(module["build-commands"]).toContain(
      "install -Dm644 m.xml /app/share/metainfo/io.github.other.app.metainfo.xml"
    );
  });
});

describe("writeManifest", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("writes <app-id>.yaml and returns its path", async () => {
    const manifest = baseManifest(ctx, appModule);

    const path = await writeManifest("/out/make/flatpak-builder", manifest);

    expect(path).toBe(
      "/out/make/flatpak-builder/io.github.yucling.open-orpheus.yaml"
    );
    expect(vol.existsSync(path)).toBe(true);
  });

  it("round-trips the manifest through YAML", async () => {
    const manifest = baseManifest(ctx, appModule);

    const path = await writeManifest("/out", manifest);
    const parsed = yaml.parse(await readFile(path, "utf-8"));

    expect(parsed).toEqual(manifest);
  });

  it("creates missing directories and overwrites previous output", async () => {
    vol.mkdirSync("/out", { recursive: true });
    await writeManifest("/out", baseManifest(ctx, appModule));

    const second = baseManifest({ ...ctx, branch: "beta" }, appModule);
    await writeManifest("/out", second);

    const parsed = yaml.parse(
      await readFile("/out/io.github.yucling.open-orpheus.yaml", "utf-8")
    );
    expect(parsed.branch).toBe("beta");
    expect(vol.readdirSync("/out")).toEqual([
      "io.github.yucling.open-orpheus.yaml",
    ]);
  });
});

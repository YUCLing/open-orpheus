import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { readFile } from "node:fs/promises";

import { vol } from "memfs";
import yaml from "yaml";

import {
  baseManifest,
  DESKTOP_EXEC,
  PNPM_NATIVE_PACKAGES,
  pnpmBootstrapCommands,
  pnpmNativeSources,
  prebuiltAppModule,
  writeManifest,
  type ManifestContext,
} from "../../packaging/flatpak/manifest";

const ctx: ManifestContext = {
  appId: "io.github.yucling.open-orpheus",
  appIdentifier: "open-orpheus",
  runtimeVersion: "26.08",
  baseVersion: "26.08",
  finishArgs: ["--socket=wayland", "--share=network"],
};

const appModule = { name: "open-orpheus", buildsystem: "simple" };

describe("baseManifest", () => {
  it("assembles the runtime, base and app module", () => {
    expect(baseManifest(ctx, appModule)).toEqual({
      "app-id": "io.github.yucling.open-orpheus",
      runtime: "org.freedesktop.Platform",
      "runtime-version": "26.08",
      sdk: "org.freedesktop.Sdk",
      base: "org.electronjs.Electron2.BaseApp",
      "base-version": "26.08",
      command: DESKTOP_EXEC,
      "separate-locales": false,
      "finish-args": ["--socket=wayland", "--share=network"],
      "sdk-extensions": ["org.freedesktop.Sdk.Extension.node24"],
      modules: [appModule],
    });
  });

  it("launches through the zypak wrapper", () => {
    expect(baseManifest(ctx, appModule)["command"]).toBe("electron-wrapper");
  });

  it("adds a branch only when one is given", () => {
    expect(baseManifest({ ...ctx, branch: "stable" }, appModule)["branch"]).toBe("stable");
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

    expect(manifest["sdk-extensions"]).toEqual(["org.freedesktop.Sdk.Extension.node24", "x"]);
  });

  it("appends the app module after extra modules", () => {
    const extra = { name: "ffmpeg" };
    const manifest = baseManifest({ ...ctx, extraModules: [extra] }, appModule);

    expect(manifest["modules"]).toEqual([extra, appModule]);
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

describe("pnpmNativeSources", () => {
  // The published integrities for pnpm 12.8.1, as `dist.integrity` spells them.
  const x64Integrity =
    "sha512-8bDZ0lZlCdi2rvnFul7EYgcC7zKeWSe76y8JV2oXobaS8p9i9d6PSf6LgLtTM0fI7R9Oh4eLCbveXyNDMmvZ+g==";
  const arm64Integrity =
    "sha512-q4s9a9X2O3N9aeUFooW24orNrxvu20+jyVUFR5RanPCqOKKPBrgs2iywMkBBx1aXkkzdWT54/mfz8Be8sJlWEw==";
  const integrities = {
    [PNPM_NATIVE_PACKAGES["x86_64"]]: x64Integrity,
    [PNPM_NATIVE_PACKAGES["aarch64"]]: arm64Integrity,
  };

  it("declares one arch-filtered native binary source per arch", () => {
    expect(pnpmNativeSources({ pnpmVersion: "12.8.1", integrities })).toEqual([
      {
        type: "file",
        url: "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.8.1.tgz",
        sha512:
          "f1b0d9d2566509d8b6aef9c5ba5ec4620702ef329e5927bbeb2f09576a17a1b692f29f62f5de8f49fe8b80bb533347c8ed1f4e87878b09bbde5f2343326bd9fa",
        "dest-filename": "pnpm-exe-x86_64.tgz",
        "only-arches": ["x86_64"],
      },
      {
        type: "file",
        url: "https://registry.npmjs.org/@pnpm/exe.linux-arm64/-/exe.linux-arm64-12.8.1.tgz",
        sha512:
          "ab8b3d6bd5f63b737d69e505a285b6e28acdaf1beedb4fa3c9550547945a9cf0aa38a28f06b82cda2cb0324041c75697924cdd593e78fe67f3f017bcb0995613",
        "dest-filename": "pnpm-exe-aarch64.tgz",
        "only-arches": ["aarch64"],
      },
    ]);
  });

  it("refuses to emit a source without a pinned integrity", () => {
    expect(() => pnpmNativeSources({ pnpmVersion: "12.8.1", integrities: {} })).toThrow(
      /integrity/i
    );
  });

  it("rejects an integrity that is not a sha512", () => {
    expect(() =>
      pnpmNativeSources({
        pnpmVersion: "12.8.1",
        integrities: { ...integrities, [PNPM_NATIVE_PACKAGES["x86_64"]]: "sha256-YWJj" },
      })
    ).toThrow(/sha512/);
  });

  it("rejects a sha512 digest that is not 64 bytes", () => {
    expect(() =>
      pnpmNativeSources({
        pnpmVersion: "12.8.1",
        integrities: { ...integrities, [PNPM_NATIVE_PACKAGES["x86_64"]]: "sha512-YWJj" },
      })
    ).toThrow(/64-byte/);
  });
});

describe("pnpmBootstrapCommands", () => {
  const PREFIX = "$FLATPAK_BUILDER_BUILDDIR/.npm-prefix";
  const TARBALL = "pnpm-12.8.1.tgz";
  const nativeDir = `${PREFIX}/lib/node_modules/@pnpm/exe.linux-$(node -p process.arch)`;

  it("installs the wrapper without lifecycle scripts or optional dependencies", () => {
    const [first] = pnpmBootstrapCommands(PREFIX, TARBALL);

    expect(first).toBe(
      `npm install -g --ignore-scripts --omit=optional --no-audit --no-fund --offline --no-update-notifier --prefix ${PREFIX} ./${TARBALL}`
    );
  });

  it("keeps npm off the network, which would otherwise stall the build", () => {
    const [first] = pnpmBootstrapCommands(PREFIX, TARBALL);

    expect(first).toContain("--offline");
    expect(first).toContain("--no-update-notifier");
  });

  it("unpacks the native binary into the layout npm would have produced", () => {
    const commands = pnpmBootstrapCommands(PREFIX, TARBALL);

    expect(commands).toContain(`install -d ${nativeDir}`);
    expect(commands).toContain(`tar xf pnpm-exe-*.tgz -C ${nativeDir} --strip-components=1`);
  });

  it("links the wrapper only once the binary is in place", () => {
    const commands = pnpmBootstrapCommands(PREFIX, TARBALL);
    const linker = commands.indexOf(`node ${PREFIX}/lib/node_modules/pnpm/install.js`);

    expect(linker).toBeGreaterThan(commands.findIndex((command) => command.startsWith("tar xf")));
    expect(linker).toBeLessThan(commands.length);
  });
});

describe("writeManifest", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("writes <app-id>.yaml and returns its path", async () => {
    const manifest = baseManifest(ctx, appModule);

    const path = await writeManifest("/out/make/flatpak-builder", manifest);

    expect(path).toBe("/out/make/flatpak-builder/io.github.yucling.open-orpheus.yaml");
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

    const parsed = yaml.parse(await readFile("/out/io.github.yucling.open-orpheus.yaml", "utf-8"));
    expect(parsed.branch).toBe("beta");
    expect(vol.readdirSync("/out")).toEqual(["io.github.yucling.open-orpheus.yaml"]);
  });
});

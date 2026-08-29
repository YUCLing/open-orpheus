import { execFile as execFileCb } from "node:child_process";
import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import type { MakerFlatpakOptions } from "../packaging/types.ts";

import { createDirectoryTarball } from "../packaging/common/archive.ts";
import { makeInStaging } from "../packaging/common/maker.ts";
import { runStreaming } from "../packaging/common/process.ts";
import {
  baseManifest,
  prebuiltAppModule,
  writeManifest,
} from "../packaging/flatpak/manifest.ts";

const execFile = promisify(execFileCb);

/**
 * Custom Flatpak maker that reuses the already-packaged Electron app (and its
 * bundled native modules) through a prebuilt-aware Flathub builder manifest —
 * no compile inside the sandbox — then builds and bundles it into a `.flatpak`.
 */
export default class MakerFlatpak extends MakerBase<MakerFlatpakOptions> {
  name = "flatpak";
  defaultPlatforms: ForgePlatform[] = ["linux"];
  requiredExternalBinaries = ["flatpak", "flatpak-builder"];

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === "linux";
  }

  async make(opts: MakerOptions): Promise<string[]> {
    const { dir, makeDir, targetArch, packageJSON } = opts;
    const projectRoot = resolve(import.meta.dirname, "..");

    const appIdentifier = this.config.name ?? packageJSON.name;
    const appId = this.config.id;
    if (!appId) {
      throw new Error("MakerFlatpak requires `id` (the Flatpak app ID).");
    }
    const runtimeVersion = this.config.runtimeVersion ?? "25.08";
    const baseVersion = this.config.baseVersion ?? "25.08";
    const finishArgs = this.config.finishArgs ?? [];
    const metainfo = this.config.metainfo ?? "packaging/flatpak/metainfo.xml";
    // Flathub apps live on the `stable` branch (default in baseManifest too).
    const branch = "stable";
    // Forge arches (x64/arm64) differ from Flatpak's (x86_64/aarch64).
    const flatpakArch =
      { x64: "x86_64", arm64: "aarch64", ia32: "i386" }[targetArch] ??
      targetArch;

    // Do all the work in a temp staging dir; only the .flatpak is moved out.
    return makeInStaging(resolve(makeDir, "flatpak"), async (staging) => {
      // 1. Generate the scaffold on the host (node_modules is available here),
      //    mirroring the deb/rpm prebuilt flow — the sandbox must not run node.
      const payload = join(staging, "payload");
      await execFile(
        process.execPath,
        [
          "scripts/build-scaffold.ts",
          join(payload, "scaffold"),
          "--name",
          appIdentifier,
          "--desktop-name",
          appId,
          "--icon-app-name",
          appId,
          "--app-path",
          `/lib/${appIdentifier}`,
          "--icons-path",
          "/share/icons/hicolor",
          "--desktop-path",
          "/share/applications",
          "--symlink-path",
          `/bin/${appIdentifier}`,
          "--with-zypak-wrapper",
        ],
        { cwd: projectRoot }
      );

      // 2. Bundle app + scaffold + metainfo into one archive source.
      await cp(dir, join(payload, "app"), { recursive: true });
      const metainfoName = `${appId}.metainfo.xml`;
      await cp(resolve(projectRoot, metainfo), join(payload, metainfoName));

      const appBundle = `${appIdentifier}-linux-${targetArch}.tar.gz`;
      await createDirectoryTarball(payload, resolve(staging, appBundle));

      // 3. Prebuilt-aware manifest (shared with build-flatpak-builder.ts).
      //    No node needed in the sandbox → no SDK extension.
      const ctx = {
        appId,
        appIdentifier,
        runtimeVersion,
        baseVersion,
        finishArgs,
        branch,
        sdkExtensions: [],
        extraModules: this.config.modules,
      };
      const manifest = baseManifest(
        ctx,
        prebuiltAppModule(ctx, { appBundle, metainfo: metainfoName })
      );
      const manifestPath = await writeManifest(staging, manifest);

      // 4. Build into a local repo (no compile — the sandbox only copies the
      //    bundled app + scaffold into /app). State dir stays in staging too,
      //    so no stray .flatpak-builder anywhere else.
      const repo = resolve(staging, "repo");
      const buildDir = resolve(staging, "build");
      const stateDir = resolve(staging, ".flatpak-builder");
      await runStreaming(
        "flatpak-builder",
        [
          "--force-clean",
          `--state-dir=${stateDir}`,
          `--repo=${repo}`,
          buildDir,
          manifestPath,
        ],
        { cwd: projectRoot }
      );

      // 5. Export the repo as a single-file bundle, named per Flatpak
      //    convention: <app-id>_<branch>_<arch>.flatpak.
      const bundle = resolve(
        staging,
        `${appId}_${branch}_${flatpakArch}.flatpak`
      );
      await runStreaming("flatpak", [
        "build-bundle",
        repo,
        bundle,
        appId,
        branch,
      ]);

      return [bundle];
    });
  }
}

import { resolve } from "node:path";

import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import type { MakerAppImageOptions } from "../packaging/types.ts";

import { appimageArch } from "../packaging/common/arch.ts";
import { makeInStaging } from "../packaging/common/maker.ts";
import { buildAppImage } from "../packaging/appimage/image.ts";

/**
 * Custom AppImage maker that reuses the already-packaged Electron app: it
 * assembles an AppDir (`usr/lib/<name>` + desktop entry + icons + `AppRun`),
 * squashes it with the system `mksquashfs` and prepends the AppImage type-2
 * runtime — i.e. what `appimagetool` does, without requiring it.
 */
export default class MakerAppImage extends MakerBase<MakerAppImageOptions> {
  name = "AppImage";
  defaultPlatforms: ForgePlatform[] = ["linux"];
  requiredExternalBinaries = ["mksquashfs"];

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === "linux";
  }

  async make(opts: MakerOptions): Promise<string[]> {
    const { dir, makeDir, targetArch, packageJSON } = opts;
    const projectRoot = resolve(import.meta.dirname, "..");
    const name: string = this.config.name ?? packageJSON.name;
    const version: string = packageJSON.version;
    // AppImage spells architectures differently from Forge (x86_64 vs x64).
    const arch = appimageArch(targetArch);
    const outDir = resolve(makeDir, "AppImage", arch);

    // Built in a temp staging dir; only the .AppImage is moved to the out dir.
    return makeInStaging(
      outDir,
      async (staging) => [
        await buildAppImage({
          projectRoot,
          appDir: dir,
          outDir: staging,
          name,
          version,
          arch,
          icon: this.config.icon,
          desktopFile: this.config.desktopFile,
          compressor: this.config.compressor,
          runtime: this.config.runtime,
          runtimeChecksum: this.config.runtimeChecksum,
        }),
      ],
      this.config.clean ?? true
    );
  }
}

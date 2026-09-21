import { resolve } from "node:path";

import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import type { MakerDebOptions } from "../../packaging/types.ts";

import { buildDeb } from "../../packaging/deb/source.ts";
import { nodeArch } from "../../packaging/common/arch.ts";
import { makeInStaging } from "../../packaging/common/maker.ts";

/**
 * Custom Debian (.deb) maker that reuses the already-packaged Electron app
 * (and its bundled native modules) through the shared prebuilt builder instead
 * of recompiling.
 */
export default class MakerDeb extends MakerBase<MakerDebOptions> {
  name = "deb";
  defaultPlatforms: ForgePlatform[] = ["linux"];
  override requiredExternalBinaries = ["dpkg-buildpackage"];

  override isSupportedOnCurrentPlatform(): boolean {
    return process.platform === "linux";
  }

  override async make(opts: MakerOptions): Promise<string[]> {
    const { dir, makeDir, targetArch } = opts;
    // Built in a temp staging dir; only the .deb is moved to the out dir.
    const outDir = resolve(makeDir, "deb", nodeArch(targetArch));
    return makeInStaging(
      outDir,
      (staging) =>
        buildDeb({
          outDir: staging,
          prebuilt: dir,
          nodeps: this.config.nodeps ?? true,
        }),
      this.config.clean ?? true
    );
  }
}

import { resolve } from "node:path";

import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import type { MakerDebOptions } from "../packaging/types.ts";

import { buildDeb } from "../packaging/deb/source.ts";
import { makeInStaging } from "../packaging/common/maker.ts";

/**
 * Custom Debian (.deb) maker that reuses the already-packaged Electron app
 * (and its bundled native modules) through the shared prebuilt builder instead
 * of recompiling.
 */
export default class MakerDeb extends MakerBase<MakerDebOptions> {
  name = "deb";
  defaultPlatforms: ForgePlatform[] = ["linux"];
  requiredExternalBinaries = ["dpkg-buildpackage"];

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === "linux";
  }

  async make(opts: MakerOptions): Promise<string[]> {
    const { dir, makeDir } = opts;
    // Build everything in a temp staging dir; only the .deb is moved out.
    return makeInStaging(resolve(makeDir, "deb"), (staging) =>
      buildDeb({
        outDir: staging,
        prebuilt: dir,
        nodeps: this.config.nodeps ?? true,
      })
    );
  }
}

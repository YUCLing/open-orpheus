import { resolve } from "node:path";

import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import type { MakerRpmOptions } from "../packaging/types.ts";

import { buildRpm } from "../packaging/rpm/build.ts";

/**
 * Custom RPM maker that reuses the already-packaged Electron app (and its
 * bundled native modules) through the shared prebuilt SRPM builder instead of
 * recompiling.
 */
export default class MakerRpm extends MakerBase<MakerRpmOptions> {
  name = "rpm";
  defaultPlatforms: ForgePlatform[] = ["linux"];
  requiredExternalBinaries = ["rpmbuild"];

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === "linux";
  }

  async make(opts: MakerOptions): Promise<string[]> {
    const { dir, makeDir } = opts;
    return buildRpm({
      outDir: resolve(makeDir, "rpm"),
      prebuilt: dir,
      nodeps: this.config.nodeps ?? true,
    });
  }
}

import { resolve } from "node:path";

import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import type { MakerRpmOptions } from "../packaging/types.ts";

import { buildRpm } from "../packaging/rpm/build.ts";
import { rpmArch } from "../packaging/common/arch.ts";
import { makeInStaging } from "../packaging/common/maker.ts";

/**
 * Custom RPM maker that reuses the already-packaged Electron app (and its
 * bundled native modules) through the shared prebuilt SRPM builder instead of
 * recompiling.
 */
export default class MakerRpm extends MakerBase<MakerRpmOptions> {
  name = "rpm";
  defaultPlatforms: ForgePlatform[] = ["linux"];
  override requiredExternalBinaries = ["rpmbuild"];

  override isSupportedOnCurrentPlatform(): boolean {
    return process.platform === "linux";
  }

  override async make(opts: MakerOptions): Promise<string[]> {
    const { dir, makeDir, targetArch } = opts;
    // Built in a temp staging dir; only the .rpm is moved to the out dir.
    const outDir = resolve(makeDir, "rpm", rpmArch(targetArch));
    return makeInStaging(
      outDir,
      (staging) =>
        buildRpm({
          outDir: staging,
          prebuilt: dir,
          nodeps: this.config.nodeps ?? true,
        }),
      this.config.clean ?? true
    );
  }
}

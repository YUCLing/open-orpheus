import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { api } from "@electron-forge/core";

export default async function () {
  const testTemp = (process.env["TEST_PACKAGED_DIR"] = await mkdtemp(
    join(tmpdir(), "open-orpheus-e2e")
  ));
  const dataDir = join(testTemp, "data");

  await mkdir(dataDir, { recursive: true });

  if (!("TEST_SKIP_BUILD" in process.env)) {
    process.env["FORGE_BUILD_ONLY"] = "1";
    try {
      await api.package({ interactive: true, outDir: join(testTemp) });
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "FORGE_BUILD_ONLY") throw e;
    } finally {
      delete process.env["FORGE_BUILD_ONLY"];
    }
  }

  if ("USE_DEV_DATA_PACKAGE" in process.env) {
    const packageDir = resolve(import.meta.dirname, "../../data/package");
    await cp(packageDir, join(dataDir, "package"), { recursive: true });
  }

  process.env["OPEN_ORPHEUS_IGNORE_SINGLE_INSTANCE"] = "1";
  process.env["CUSTOM_DATA_DIR"] = dataDir;
}

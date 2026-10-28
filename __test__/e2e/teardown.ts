import { rm } from "node:fs/promises";

export default async function () {
  const testTemp = process.env["TEST_PACKAGED_DIR"];
  if (testTemp) {
    await rm(testTemp, { recursive: true, force: true });
  }
  ["TEST_PACKAGED_DIR", "CUSTOM_DATA_DIR", "OPEN_ORPHEUS_IGNORE_SINGLE_INSTANCE"].forEach((v) => {
    delete process.env[v];
  });
}

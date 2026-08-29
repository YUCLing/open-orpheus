import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => (await import("memfs")).fs.promises);

import { vol } from "memfs";

import { createSymlink } from "../../packaging/common/util";

describe("createSymlink", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("creates a relocatable relative symlink", async () => {
    await createSymlink(
      "/usr/lib/open-orpheus/open-orpheus",
      "/usr/bin/open-orpheus"
    );
    expect(vol.toSnapshot()).toMatchSnapshot();
  });

  it("creates parent directories for the link", async () => {
    await createSymlink("/opt/lib/foo/foo", "/opt/bin/foo");
    expect(vol.toSnapshot()).toMatchSnapshot();
  });

  it("replaces an existing entry at the link path", async () => {
    vol.fromJSON({ "/usr/bin/open-orpheus": "stale-binary" });
    await createSymlink(
      "/usr/lib/open-orpheus/open-orpheus",
      "/usr/bin/open-orpheus"
    );
    expect(vol.toSnapshot()).toMatchSnapshot();
  });
});

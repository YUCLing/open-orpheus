import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { vol } from "memfs";

import { createSymlink } from "../../packaging/common/util";

// POSIX symlink targets are part of the Linux package layout. Windows would
// create reparse points with backslash targets (and needs extra privileges),
// so this behaviour is only meaningful on POSIX hosts.
describe.runIf(process.platform !== "win32")("createSymlink", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("creates a relocatable relative symlink", async () => {
    await createSymlink("/usr/lib/open-orpheus/open-orpheus", "/usr/bin/open-orpheus");
    expect(vol.toSnapshot()).toMatchSnapshot();
  });

  it("creates parent directories for the link", async () => {
    await createSymlink("/opt/lib/foo/foo", "/opt/bin/foo");
    expect(vol.toSnapshot()).toMatchSnapshot();
  });

  it("replaces an existing entry at the link path", async () => {
    vol.fromJSON({ "/usr/bin/open-orpheus": "stale-binary" });
    await createSymlink("/usr/lib/open-orpheus/open-orpheus", "/usr/bin/open-orpheus");
    expect(vol.toSnapshot()).toMatchSnapshot();
  });
});

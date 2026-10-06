import { describe, expect, it } from "vitest";

import { normalizePath, sanitizeRelativePath } from "@main/platform/utils/path";

const onPosix = process.platform !== "win32";

describe.runIf(onPosix)("normalizePath", () => {
  it("normalises posix paths", () => {
    expect(normalizePath("/a/b", "c/d")).toBe("/a/b/c/d");
    expect(normalizePath("/a", "b/../c")).toBe("/a/c");
  });

  it("converts windows separators on other platforms", () => {
    expect(normalizePath("/a", "b\\c")).toBe("/a/b/c");
  });
});

describe.runIf(onPosix)("sanitizeRelativePath", () => {
  it("resolves paths inside the base directory", () => {
    expect(sanitizeRelativePath("/base", "sub/file.txt")).toBe("/base/sub/file.txt");
    expect(sanitizeRelativePath("/base", "a/../b.txt")).toBe("/base/b.txt");
    expect(sanitizeRelativePath("/base", "sub\\file.txt")).toBe("/base/sub/file.txt");
  });

  it("resolves the base directory itself", () => {
    expect(sanitizeRelativePath("/base", ".")).toBe("/base");
    expect(sanitizeRelativePath("/base", "")).toBe("/base");
  });

  it("rejects path traversal", () => {
    expect(sanitizeRelativePath("/base", "../other")).toBe(false);
    expect(sanitizeRelativePath("/base", "../../etc/passwd")).toBe(false);
    expect(sanitizeRelativePath("/base", "sub/../../other")).toBe(false);
  });

  it("rejects siblings sharing the base prefix", () => {
    expect(sanitizeRelativePath("/base", "../base-evil/x")).toBe(false);
  });
});

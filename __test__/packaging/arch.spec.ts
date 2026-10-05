import { describe, expect, it } from "vitest";

import { appimageArch, flatpakArch, nodeArch, rpmArch } from "../../packaging/common/arch";

describe("nodeArch", () => {
  it("passes the arch through", () => {
    expect(nodeArch("x64")).toBe("x64");
    expect(nodeArch("arm64")).toBe("arm64");
  });

  it("defaults to the host arch", () => {
    expect(nodeArch()).toBe(process.arch);
  });
});

describe("rpmArch", () => {
  it("maps Electron arch names to RPM names", () => {
    expect(rpmArch("x64")).toBe("x86_64");
    expect(rpmArch("arm64")).toBe("aarch64");
    expect(rpmArch("ia32")).toBe("i686");
    expect(rpmArch("arm")).toBe("armv7hl");
  });

  it("passes unknown arches through", () => {
    expect(rpmArch("loong64")).toBe("loong64");
    expect(rpmArch("riscv64")).toBe("riscv64");
  });

  it("falls back to the host arch", () => {
    expect(rpmArch()).toBe(rpmArch(nodeArch()));
  });
});

describe("flatpakArch", () => {
  it("maps Electron arch names to Flatpak names", () => {
    expect(flatpakArch("x64")).toBe("x86_64");
    expect(flatpakArch("arm64")).toBe("aarch64");
    expect(flatpakArch("ia32")).toBe("i386");
  });

  it("passes unmapped arches through unchanged", () => {
    // Flatpak has no `arm` spelling, so the node name is kept as-is.
    expect(flatpakArch("arm")).toBe("arm");
    expect(flatpakArch("loong64")).toBe("loong64");
  });

  it("falls back to the host arch", () => {
    expect(flatpakArch()).toBe(flatpakArch(nodeArch()));
  });

  it("agrees with rpmArch where both define a spelling", () => {
    expect(flatpakArch("x64")).toBe(rpmArch("x64"));
    expect(flatpakArch("arm64")).toBe(rpmArch("arm64"));
    // …and disagrees where the formats do (i386 vs i686).
    expect(flatpakArch("ia32")).not.toBe(rpmArch("ia32"));
  });
});

describe("appimageArch", () => {
  it("maps Electron arch names to AppImage (runtime) names", () => {
    expect(appimageArch("x64")).toBe("x86_64");
    expect(appimageArch("arm64")).toBe("aarch64");
    expect(appimageArch("ia32")).toBe("i686");
    // AppImage has an `armhf` spelling, so armv7l is mapped rather than passed through.
    expect(appimageArch("armv7l")).toBe("armhf");
  });

  it("passes unknown arches through", () => {
    expect(appimageArch("loong64")).toBe("loong64");
  });

  it("falls back to the host arch", () => {
    expect(appimageArch()).toBe(appimageArch(nodeArch()));
  });

  it("agrees with rpmArch on the shared spellings", () => {
    for (const arch of ["x64", "arm64", "ia32"]) {
      expect(appimageArch(arch)).toBe(rpmArch(arch));
    }
  });
});

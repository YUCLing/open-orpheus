import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { readFile } from "node:fs/promises";

import { vol } from "memfs";

import {
  createSpecFile,
  generateSpec,
  type SpecOptions,
} from "../../packaging/rpm/spec";

const base: SpecOptions = {
  name: "open-orpheus",
  version: "0.17.1",
  release: "1",
  summary: "An open-source implementation of Orpheus",
  description: "Line one.\nLine two.",
  license: "MIT",
  homepage: "https://github.com/YUCLing/open-orpheus",
  nodeVersion: "24",
  wasmBindgen: "0.2.100",
  cargoZigbuild: "0.23.4",
  zig: "0.16.0",
  changelog: "* Mon Sep 15 2025 A <a@b.c> - 0.17.1-1\n- Release 0.17.1",
};

describe("generateSpec", () => {
  it("renders the header fields", async () => {
    const spec = await generateSpec(base);

    expect(spec).toContain("Name:           open-orpheus");
    expect(spec).toContain("Version:        0.17.1");
    expect(spec).toContain("Release:        1");
    expect(spec).toContain("Summary:        An open-source implementation");
    expect(spec).toContain("License:        MIT");
    expect(spec).toContain(
      "URL:            https://github.com/YUCLing/open-orpheus"
    );
    expect(spec).toContain("Source0:        %{name}-%{version}.tar.gz");
    expect(spec).toContain("AutoReqProv:    no");
  });

  it("renders the required sections and the changelog", async () => {
    const spec = await generateSpec(base);

    for (const section of [
      "%prep",
      "%build",
      "%install",
      "%files",
      "%changelog",
    ]) {
      expect(spec).toContain(section);
    }
    expect(spec).toContain("%setup -q");
    expect(spec).toContain("- Release 0.17.1");
    expect(spec.trimEnd().endsWith("- Release 0.17.1")).toBe(true);
    expect(spec).toContain("%description\nLine one.\nLine two.");
  });

  it("declares the runtime build requirements", async () => {
    const spec = await generateSpec(base);

    expect(spec).toContain("Requires:       (nss or mozilla-nss), gtk3");
    expect(spec).toContain("BuildRequires:  gcc, gcc-c++, make, git, curl");
    expect(spec).toContain("%global debug_package %{nil}");
  });

  it("installs the toolchain and packages the app by default", async () => {
    const spec = await generateSpec(base);

    expect(spec).toContain("sh.rustup.rs");
    expect(spec).toContain('cargo install "wasm-bindgen-cli@0.2.100"');
    expect(spec).toContain("nvm install 24");
    expect(spec).toContain(
      "releases/download/v0.23.4/cargo-zigbuild-${BUILD_ARCH}-unknown-linux-gnu.tar.xz"
    );
    expect(spec).toContain("ziglang.org/download/0.16.0/");
    expect(spec).toContain("pnpm install --frozen-lockfile");
    expect(spec).toContain("pnpm run build:modules");
    expect(spec).toContain("pnpm run package");
    expect(spec).toContain(
      "node scripts/build-scaffold.ts %{_builddir}/%{name}-%{version}/rpm-scaffold --name %{name}"
    );
  });

  it("skips the toolchain when installTools is false", async () => {
    const spec = await generateSpec({ ...base, installTools: false });

    expect(spec).not.toContain("sh.rustup.rs");
    expect(spec).not.toContain("nvm install");
    expect(spec).toContain("pnpm install --frozen-lockfile");
    expect(spec).toContain("pnpm run package");
  });

  it("bundles the prebuilt app as Source1", async () => {
    const spec = await generateSpec({ ...base, prebuilt: true });

    expect(spec).toContain(
      "Source1:        %{name}-%{version}-prebuilt.tar.gz"
    );
    expect(spec).toContain(
      "tar xzf %{_sourcedir}/%{name}-%{version}-prebuilt.tar.gz"
    );
    expect(spec).not.toContain("pnpm run package");
    expect(spec).not.toContain("sh.rustup.rs");
    expect(spec).toContain(
      "cp -r %{_builddir}/%{name}-%{version}/%{name}-%{version}-prebuilt/scaffold/usr %{buildroot}/"
    );
    expect(spec).toContain(
      "cp -r %{_builddir}/%{name}-%{version}/%{name}-%{version}-prebuilt/app/. %{buildroot}/usr/lib/%{name}/"
    );
  });

  it("does not declare Source1 for a source build", async () => {
    expect(await generateSpec(base)).not.toContain("Source1:");
  });

  it("sanitises the build flags Copr and zig cc reject", async () => {
    const spec = await generateSpec(base);

    expect(spec).toContain("strip_flags()");
    for (const flag of [
      "-flto=auto",
      "-ffat-lto-objects",
      "-fno-omit-frame-pointer",
      "-mno-omit-leaf-frame-pointer",
      "-mtune=",
      "-march=",
    ]) {
      expect(spec).toContain(flag);
    }
    expect(spec).toContain(
      "sed 's|-Clink-arg=-specs=/usr/lib/rpm/redhat/redhat-package-notes||g'"
    );
    // POSIX parameter expansion only: `%build` may run under dash.
    expect(spec).not.toContain("${RUSTFLAGS//");
    expect(spec).not.toContain("${CFLAGS//");
  });

  it("keeps the SUID sandbox, license and file list", async () => {
    const spec = await generateSpec(base);

    expect(spec).toContain(
      "chmod 4755 %{buildroot}/usr/lib/%{name}/chrome-sandbox"
    );
    expect(spec).toContain(
      "install -Dm0644 LICENSE %{buildroot}%{_licensedir}/%{name}/LICENSE"
    );
    expect(spec).toContain("/usr/bin/%{name}");
    expect(spec).toContain("/usr/share/applications/%{name}.desktop");
    expect(spec).toContain("/usr/share/icons/hicolor/256x256/apps/%{name}.png");
    expect(spec).toContain("/usr/share/icons/hicolor/512x512/apps/%{name}.png");
    expect(spec).toContain(
      "/usr/share/icons/hicolor/scalable/apps/%{name}.svg"
    );
  });
});

describe("createSpecFile", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("writes the rendered spec", async () => {
    vol.mkdirSync("/stage", { recursive: true });

    await createSpecFile("/stage/open-orpheus.spec", base);

    await expect(
      readFile("/stage/open-orpheus.spec", "utf-8")
    ).resolves.toContain("Name:           open-orpheus");
  });
});

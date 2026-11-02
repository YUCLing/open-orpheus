import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { readFile } from "node:fs/promises";

import { vol } from "memfs";

import { createRulesFile, generateRules, type RulesOptions } from "../../packaging/deb/rules";
import { RUST_VERSION } from "../../packaging/common/toolchain";

const base: RulesOptions = {
  name: "open-orpheus",
  rust: RUST_VERSION,
};

describe("generateRules", () => {
  it("installs the toolchain and packages the app by default", async () => {
    const rules = await generateRules(base);

    expect(rules).toContain("dh $@");
    expect(rules).toContain("override_dh_auto_build:");
    expect(rules).toContain("sh.rustup.rs");
    expect(rules).toContain("rustup target add wasm32-unknown-unknown");
    expect(rules).toContain("pnpm install --frozen-lockfile");
    expect(rules).toContain("pnpm run build:modules");
    expect(rules).toContain("pnpm run package");
  });

  it("pins the Rust toolchain version", async () => {
    const rules = await generateRules(base);

    expect(rules).toContain(`--default-toolchain ${RUST_VERSION}`);
    // The old cargo-zigbuild/zig cross toolchain is no longer provisioned.
    expect(rules).not.toContain("cargo-zigbuild");
    expect(rules).not.toContain("ziglang.org");
  });

  it("interpolates the package name into the scaffolder call", async () => {
    const rules = await generateRules({ ...base, name: "my-app" });

    expect(rules).toContain("node scripts/build-scaffold.ts rpm-scaffold --name my-app");
  });

  it("skips the toolchain when installTools is false", async () => {
    const rules = await generateRules({ ...base, installTools: false });

    expect(rules).not.toContain("sh.rustup.rs");
    expect(rules).not.toContain("nvm.sh");
    // …but still builds the app and the native modules.
    expect(rules).toContain("pnpm install --frozen-lockfile");
    expect(rules).toContain("pnpm run package");
  });

  it("installs the toolchain when installTools is explicitly true", async () => {
    const rules = await generateRules({ ...base, installTools: true });

    expect(rules).toContain("sh.rustup.rs");
  });

  it("copies the bundled app instead of building for prebuilt", async () => {
    const rules = await generateRules({ ...base, prebuilt: true });

    expect(rules).not.toContain("pnpm run package");
    expect(rules).not.toContain("sh.rustup.rs");
    expect(rules).not.toContain("rpm-scaffold");
    expect(rules).toContain("cp -r prebuilt/scaffold/usr debian/open-orpheus/");
    expect(rules).toContain("cp -r prebuilt/app/. debian/open-orpheus/usr/lib/open-orpheus/");
  });

  it("keeps the SUID sandbox and no-strip overrides in every mode", async () => {
    for (const rules of [
      await generateRules(base),
      await generateRules({ ...base, installTools: false }),
      await generateRules({ ...base, prebuilt: true }),
    ]) {
      expect(rules).toContain("override_dh_fixperms:");
      expect(rules).toContain("chmod 4755");
      expect(rules).toContain("override_dh_strip:");
      expect(rules).toContain("override_dh_dwz:");
      expect(rules).toContain("override_dh_shlibdeps:");
    }
  });
});

describe("createRulesFile", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("writes an executable makefile", async () => {
    vol.mkdirSync("/stage/debian", { recursive: true });

    await createRulesFile("/stage/debian/rules", base);

    const written = await readFile("/stage/debian/rules", "utf-8");
    expect(written.startsWith("#!/usr/bin/make -f")).toBe(true);
    expect(written).toContain("dh $@");
  });
});

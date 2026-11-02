import { join, resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

const hoisted = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: hoisted.execFile,
  spawn: vi.fn(),
}));

import { vol } from "memfs";

import { createPrebuiltBundle, resolvePrebuiltAppDir } from "../../packaging/common/prebuilt";

const REPO = resolve("repo");
const OUT = join(REPO, "out");
const STAGE = resolve("stage", "prebuilt");
const PB_STAGE = resolve("stage", "pb");
const prebuilt = (name: string) => join(OUT, name);

type ExecFileCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

/** `execFile` in callback style, so `promisify` works on the mock. */
function execFileSucceeds() {
  hoisted.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, { stdout: "", stderr: "" });
      return {} as never;
    }
  );
}

function execFileFails(message: string) {
  hoisted.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(new Error(message));
      return {} as never;
    }
  );
}

beforeEach(() => {
  vol.reset();
  hoisted.execFile.mockReset();
  execFileSucceeds();
});

describe("resolvePrebuiltAppDir", () => {
  it("finds the packaged app for the requested arch", async () => {
    vol.fromJSON({
      [join(prebuilt("open-orpheus-linux-arm64"), "resources", "app.asar")]: "app",
    });

    await expect(resolvePrebuiltAppDir(REPO, "open-orpheus", "arm64")).resolves.toBe(
      prebuilt("open-orpheus-linux-arm64")
    );
  });

  it("falls back to the host arch", async () => {
    vol.fromJSON({
      [join(prebuilt(`open-orpheus-linux-${process.arch}`), "resources", "app.asar")]: "app",
    });

    await expect(resolvePrebuiltAppDir(REPO, "open-orpheus")).resolves.toBe(
      prebuilt(`open-orpheus-linux-${process.arch}`)
    );
  });

  it("looks only at the requested arch when one is given", async () => {
    vol.fromJSON({
      [join(prebuilt(`open-orpheus-linux-${process.arch}`), "resources", "app.asar")]: "app",
    });

    await expect(resolvePrebuiltAppDir(REPO, "open-orpheus", "arm64")).rejects.toThrow(
      /No packaged Electron app found/
    );
  });

  it("explains how to produce the directory when it is missing", async () => {
    await expect(resolvePrebuiltAppDir(REPO, "open-orpheus")).rejects.toThrow(
      "Run `pnpm package` first."
    );
  });
});

describe("createPrebuiltBundle", () => {
  it("stages the app and generates the scaffold", async () => {
    vol.fromJSON({
      [join(OUT, "open-orpheus-linux-x64", "open-orpheus")]: "binary",
      [join(OUT, "open-orpheus-linux-x64", "resources", "app.asar")]: "asar",
    });

    const dest = await createPrebuiltBundle(
      REPO,
      join(OUT, "open-orpheus-linux-x64"),
      "open-orpheus",
      STAGE
    );

    expect(dest).toBe(STAGE);
    expect(vol.existsSync(join(STAGE, "app", "open-orpheus"))).toBe(true);
    expect(vol.existsSync(join(STAGE, "app", "resources", "app.asar"))).toBe(true);
    expect(vol.existsSync(join(STAGE, "scaffold"))).toBe(true);
    expect(hoisted.execFile).toHaveBeenCalledWith(
      process.execPath,
      [
        join(REPO, "scripts", "build-scaffold.ts"),
        join(STAGE, "scaffold"),
        "--name",
        "open-orpheus",
      ],
      { cwd: REPO },
      expect.any(Function)
    );
  });

  it("replaces an existing bundle", async () => {
    vol.fromJSON({
      [join(OUT, "app-linux-x64", "app")]: "binary",
      [join(STAGE, "app", "stale")]: "old",
      [join(STAGE, "keep.txt")]: "old",
    });

    await createPrebuiltBundle(REPO, join(OUT, "app-linux-x64"), "app", STAGE);

    expect(vol.existsSync(join(STAGE, "app", "stale"))).toBe(false);
    expect(vol.existsSync(join(STAGE, "keep.txt"))).toBe(false);
    expect(vol.existsSync(join(STAGE, "app", "app"))).toBe(true);
  });

  it("surfaces scaffolder failures", async () => {
    vol.fromJSON({ [join(OUT, "app-linux-x64", "app")]: "binary" });
    execFileFails("scaffold exploded");

    await expect(
      createPrebuiltBundle(REPO, join(OUT, "app-linux-x64"), "app", PB_STAGE)
    ).rejects.toThrow("scaffold exploded");
  });
});

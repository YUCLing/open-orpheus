import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

const hoisted = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: hoisted.execFile,
  spawn: vi.fn(),
}));

import { vol } from "memfs";

import {
  createPrebuiltBundle,
  resolvePrebuiltAppDir,
} from "../../packaging/common/prebuilt";

type ExecFileCallback = (
  error: Error | null,
  result?: { stdout: string; stderr: string }
) => void;

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
      "/repo/out/open-orpheus-linux-arm64/resources/app.asar": "app",
    });

    await expect(
      resolvePrebuiltAppDir("/repo", "open-orpheus", "arm64")
    ).resolves.toBe("/repo/out/open-orpheus-linux-arm64");
  });

  it("falls back to the host arch", async () => {
    vol.fromJSON({
      [`/repo/out/open-orpheus-linux-${process.arch}/resources/app.asar`]:
        "app",
    });

    await expect(resolvePrebuiltAppDir("/repo", "open-orpheus")).resolves.toBe(
      `/repo/out/open-orpheus-linux-${process.arch}`
    );
  });

  it("looks only at the requested arch when one is given", async () => {
    vol.fromJSON({
      [`/repo/out/open-orpheus-linux-${process.arch}/resources/app.asar`]:
        "app",
    });

    await expect(
      resolvePrebuiltAppDir("/repo", "open-orpheus", "arm64")
    ).rejects.toThrow(/No packaged Electron app found/);
  });

  it("explains how to produce the directory when it is missing", async () => {
    await expect(
      resolvePrebuiltAppDir("/repo", "open-orpheus")
    ).rejects.toThrow("Run `pnpm package` first.");
  });
});

describe("createPrebuiltBundle", () => {
  it("stages the app and generates the scaffold", async () => {
    vol.fromJSON({
      "/out/open-orpheus-linux-x64/open-orpheus": "binary",
      "/out/open-orpheus-linux-x64/resources/app.asar": "asar",
    });

    const dest = await createPrebuiltBundle(
      "/repo",
      "/out/open-orpheus-linux-x64",
      "open-orpheus",
      "/stage/prebuilt"
    );

    expect(dest).toBe("/stage/prebuilt");
    expect(vol.existsSync("/stage/prebuilt/app/open-orpheus")).toBe(true);
    expect(vol.existsSync("/stage/prebuilt/app/resources/app.asar")).toBe(true);
    expect(vol.existsSync("/stage/prebuilt/scaffold")).toBe(true);
    expect(hoisted.execFile).toHaveBeenCalledWith(
      process.execPath,
      [
        "/repo/scripts/build-scaffold.ts",
        "/stage/prebuilt/scaffold",
        "--name",
        "open-orpheus",
      ],
      { cwd: "/repo" },
      expect.any(Function)
    );
  });

  it("replaces an existing bundle", async () => {
    vol.fromJSON({
      "/out/app-linux-x64/app": "binary",
      "/stage/prebuilt/app/stale": "old",
      "/stage/prebuilt/keep.txt": "old",
    });

    await createPrebuiltBundle(
      "/repo",
      "/out/app-linux-x64",
      "app",
      "/stage/prebuilt"
    );

    expect(vol.existsSync("/stage/prebuilt/app/stale")).toBe(false);
    expect(vol.existsSync("/stage/prebuilt/keep.txt")).toBe(false);
    expect(vol.existsSync("/stage/prebuilt/app/app")).toBe(true);
  });

  it("surfaces scaffolder failures", async () => {
    vol.fromJSON({ "/out/app-linux-x64/app": "binary" });
    execFileFails("scaffold exploded");

    await expect(
      createPrebuiltBundle("/repo", "/out/app-linux-x64", "app", "/stage/pb")
    ).rejects.toThrow("scaffold exploded");
  });
});

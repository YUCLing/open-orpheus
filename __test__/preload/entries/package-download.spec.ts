import { beforeEach, describe, expect, it, vi } from "vitest";

// The preload script talks to the renderer through the context bridge.
const hoisted = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: hoisted.exposeInMainWorld },
  ipcRenderer: { send: hoisted.send, on: hoisted.on, off: hoisted.off },
}));

import { PackageDownloadReason } from "$sharedTypes/package-download";

type Progress = { step: "downloading" | "extracting" | "saving" | "completed" };
type Listener = (event: unknown, progress: Progress) => void;

/**
 * (Re)load the preload script: it reads `process.argv` at import time.
 */
async function load(...argv: string[]) {
  vi.resetModules();
  vi.clearAllMocks();
  const original = process.argv;
  process.argv = ["electron", "package-download.js", ...argv];
  try {
    await import("@preload/entries/package-download");
  } finally {
    process.argv = original;
  }

  const exposed = (key: string) =>
    hoisted.exposeInMainWorld.mock.calls.find(([name]) => name === key)?.[1];

  return {
    reason: exposed("downloadReason") as PackageDownloadReason,
    downloadPackage: exposed("downloadPackage") as (
      cb: (progress: Progress) => void
    ) => void,
    /** The progress listener registered by `downloadPackage`, if any. */
    progressListener: () => hoisted.on.mock.calls[0]?.[1] as Listener,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("package download preload", () => {
  it("reports the not-found reason by default", async () => {
    const { reason } = await load();

    expect(reason).toBe(PackageDownloadReason.NotFound);
  });

  it("reads the download reason from the command line", async () => {
    const { reason } = await load("--download-reason=3");

    expect(reason).toBe(PackageDownloadReason.UpdateAvailable);
  });

  it("ignores unrelated arguments", async () => {
    const { reason } = await load("--other-flag", "--download-reasons=2");

    expect(reason).toBe(PackageDownloadReason.NotFound);
  });

  it("asks the main process for the package on download", async () => {
    const { downloadPackage } = await load();
    const callback = vi.fn();

    downloadPackage(callback);

    expect(hoisted.send).toHaveBeenCalledWith("download-package");
    expect(hoisted.on).toHaveBeenCalledWith(
      "download-package-progress",
      expect.any(Function)
    );
  });

  it("forwards progress events to the caller", async () => {
    const { downloadPackage, progressListener } = await load();
    const callback = vi.fn();
    downloadPackage(callback);

    progressListener()({}, { step: "downloading" });

    expect(callback).toHaveBeenCalledWith({ step: "downloading" });
    expect(hoisted.off).not.toHaveBeenCalled();
  });

  it("unsubscribes as soon as the download completes", async () => {
    const { downloadPackage, progressListener } = await load();
    const callback = vi.fn();
    downloadPackage(callback);
    const listener = progressListener();

    listener({}, { step: "saving" });
    listener({}, { step: "completed" });

    expect(callback).toHaveBeenNthCalledWith(1, { step: "saving" });
    expect(callback).toHaveBeenNthCalledWith(2, { step: "completed" });
    expect(hoisted.off).toHaveBeenCalledWith(
      "download-package-progress",
      listener
    );
  });
});

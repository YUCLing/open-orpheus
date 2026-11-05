import { beforeEach, describe, expect, it, vi } from "vitest";

import { PackageDownloadReason } from "@shared/types/package-download";

const hoisted = vi.hoisted(() => {
  type FakeWindow = {
    close: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
    on: (event: string, callback: () => void) => void;
    webContents: {
      isDestroyed: () => boolean;
      ipc: { on: (channel: string, callback: () => void) => void };
      send: ReturnType<typeof vi.fn>;
    };
  };

  const state = {
    downloadPackage: vi.fn(),
    ipc: new Map<string, () => void>(),
    closed: [] as Array<() => void>,
    windows: [] as FakeWindow[],
  };

  class FakeManagedWindow {
    window: FakeWindow | null = null;

    createBrowserWindow() {
      const wnd: FakeWindow = {
        close: vi.fn(),
        isDestroyed: () => false,
        on(event, callback) {
          if (event === "closed") state.closed.push(callback);
        },
        webContents: {
          isDestroyed: () => false,
          ipc: {
            on(channel, callback) {
              state.ipc.set(channel, callback);
            },
          },
          send: vi.fn(),
        },
      };
      this.window = wnd;
      state.windows.push(wnd);
      return wnd;
    }

    hideMenuBar() {}
    loadGuiRoute() {}
  }

  return { ...state, FakeManagedWindow };
});

vi.mock("../../src/main/window", () => ({ ManagedWindow: hoisted.FakeManagedWindow }));
vi.mock("../../src/main/pack", () => ({
  default: { downloadPackage: hoisted.downloadPackage },
}));

import showPackgeDownloadWindow from "../../src/main/windows/package-download";

beforeEach(() => {
  hoisted.downloadPackage.mockReset();
  hoisted.ipc.clear();
  hoisted.closed.length = 0;
  hoisted.windows.length = 0;
});

describe("PackageDownloadWindow", () => {
  it("resolves when the download completes", async () => {
    hoisted.downloadPackage.mockImplementation((onProgress: (p: unknown) => void) => {
      onProgress({ step: "completed", progress: 1 });
      return Promise.resolve();
    });

    const result = showPackgeDownloadWindow(PackageDownloadReason.UpdateAvailable);
    hoisted.ipc.get("download-package")?.();

    await expect(result).resolves.toBeUndefined();
    expect(hoisted.windows[0]?.close).toHaveBeenCalled();
  });

  it("aborts the download and rejects with CANCEL when the window closes", async () => {
    hoisted.downloadPackage.mockImplementation(
      (_onProgress: (p: unknown) => void, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        })
    );

    const result = showPackgeDownloadWindow(PackageDownloadReason.UpdateAvailable);
    hoisted.ipc.get("download-package")?.();
    const signal = hoisted.downloadPackage.mock.calls[0]?.[1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    for (const close of hoisted.closed) close();

    await expect(result).rejects.toBe("CANCEL");
    expect(signal.aborted).toBe(true);
  });
});

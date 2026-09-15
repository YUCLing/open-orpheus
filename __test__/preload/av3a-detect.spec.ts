import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcRenderer: { invoke: vi.fn() },
}));

import { ipcRenderer } from "electron";

import { isAv3aLocalFile } from "../../src/preload/av3a/detect";

describe("isAv3aLocalFile", () => {
  beforeEach(() => {
    vi.mocked(ipcRenderer.invoke).mockReset();
  });

  it("returns whatever the main process answered", async () => {
    vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);
    await expect(isAv3aLocalFile("/music/song.m4a")).resolves.toBe(true);

    vi.mocked(ipcRenderer.invoke).mockResolvedValue(false);
    await expect(isAv3aLocalFile("/music/song.mp3")).resolves.toBe(false);

    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
      "audio.isAv3aFile",
      "/music/song.mp3"
    );
  });

  it("propagates main process failures", async () => {
    vi.mocked(ipcRenderer.invoke).mockRejectedValue(new Error("no such file"));

    await expect(isAv3aLocalFile("/missing.m4a")).rejects.toThrow(
      "no such file"
    );
  });
});

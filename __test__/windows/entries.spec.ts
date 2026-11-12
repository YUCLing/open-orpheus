import { afterEach, describe, expect, it, vi } from "vitest";

// `exposeApi` reaches for `contextBridge`/`ipcRenderer`, so the bridge is faked.
const hoisted = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
}));

vi.mock("../../src/preload/bridge", () => ({
  exposeApi: (prefix: string, values: Record<string, unknown> = {}) =>
    hoisted.exposeInMainWorld(prefix, values),
}));

/** The prefixes exposed by the given module, in registration order. */
function exposed() {
  return Object.fromEntries(hoisted.exposeInMainWorld.mock.calls);
}

afterEach(() => vi.unstubAllEnvs());

describe("window preload entry points", () => {
  it("exposes the API surface each window expects", async () => {
    vi.stubEnv("FLATPAK_ID", undefined);
    // Importing these modules is what registers the API surface. They are
    // imported here rather than at file scope because Vitest clears mock call
    // history before every test, which would wipe registrations made on import.
    await import("../../src/windows/desktop-lyrics");
    await import("../../src/windows/desktop-lyrics-preview");
    await import("../../src/windows/manage");
    await import("../../src/windows/menu");
    await import("../../src/windows/mini-player");

    expect(exposed()).toEqual({
      desktopLyrics: { platform: process.platform },
      inputRegion: { platform: process.platform },
      lyrics: {},
      settings: {},
      desktopLyricsPreview: {},
      manage: {
        platform: process.platform,
        versions: process.versions,
      },
      menu: {},
      miniPlayer: {},
    });
  });

  it("exposes the same manage API in Flatpak", async () => {
    vi.resetModules();
    vi.stubEnv("FLATPAK_ID", "io.github.yucling.open-orpheus");

    await import("../../src/windows/manage");

    expect(exposed().manage).toEqual({
      platform: process.platform,
      versions: process.versions,
    });
  });
});

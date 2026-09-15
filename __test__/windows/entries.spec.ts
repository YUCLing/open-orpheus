import { describe, expect, it, vi } from "vitest";

// `exposeApi` reaches for `contextBridge`/`ipcRenderer`, so the bridge is faked.
const hoisted = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
}));

vi.mock("../../src/bridge/preload", () => ({
  exposeApi: (prefix: string, values: Record<string, unknown> = {}) =>
    hoisted.exposeInMainWorld(prefix, values),
}));

// Importing these modules is what registers the API surface.
import "../../src/windows/desktop-lyrics";
import "../../src/windows/desktop-lyrics-preview";
import "../../src/windows/manage";
import "../../src/windows/menu";
import "../../src/windows/mini-player";

/** The prefixes exposed by the given module, in registration order. */
function exposed() {
  return Object.fromEntries(hoisted.exposeInMainWorld.mock.calls);
}

describe("window preload entry points", () => {
  it("exposes the API surface each window expects", () => {
    expect(exposed()).toEqual({
      desktopLyrics: { platform: process.platform },
      inputRegion: { platform: process.platform },
      lyrics: {},
      settings: {},
      desktopLyricsPreview: {},
      manage: { platform: process.platform, versions: process.versions },
      menu: { wayland: false, submenu: false },
      miniPlayer: {},
    });
  });

  it("reads the menu switches from the command line", async () => {
    const before = hoisted.exposeInMainWorld.mock.calls.length;
    vi.resetModules();
    const original = process.argv;
    process.argv = [...original, "--wayland"];
    try {
      await import("../../src/windows/menu");
    } finally {
      process.argv = original;
    }

    // Only the freshly imported module's registrations.
    const menu = Object.fromEntries(
      hoisted.exposeInMainWorld.mock.calls.slice(before)
    );

    expect(menu).toEqual({
      menu: { wayland: true, submenu: false },
      inputRegion: { platform: process.platform },
    });
  });
});

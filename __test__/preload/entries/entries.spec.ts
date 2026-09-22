import { describe, expect, it, vi } from "vitest";

// The bridge reaches for `contextBridge`/`ipcRenderer`, so electron is faked.
const hoisted = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: hoisted.exposeInMainWorld },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}));

// Importing these modules is what registers the API surface.
import "@preload/entries/desktop-lyrics";
import "@preload/entries/desktop-lyrics-preview";
import "@preload/entries/manage";
import "@preload/entries/menu";
import "@preload/entries/mini-player";

/**
 * The sync values exposed per prefix, in registration order, from call #`from`
 * onwards, without the bridge's own `_call`/`_on` plumbing.
 */
function exposed(from = 0) {
  return Object.fromEntries(
    hoisted.exposeInMainWorld.mock.calls
      .slice(from)
      .map(([prefix, values]) => [prefix, syncValues(values)])
  );
}

function syncValues(values: unknown) {
  return Object.fromEntries(
    Object.entries(values as Record<string, unknown>).filter(
      ([key]) => !key.startsWith("_")
    )
  );
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

  it("gives every prefix the call plumbing the renderer proxy needs", () => {
    for (const [, values] of hoisted.exposeInMainWorld.mock.calls) {
      expect(Object.keys(values as object)).toEqual(
        expect.arrayContaining(["_call", "_on"])
      );
    }
  });

  it("reads the menu switches from the command line", async () => {
    const before = hoisted.exposeInMainWorld.mock.calls.length;
    vi.resetModules();
    const original = process.argv;
    process.argv = [...original, "--wayland"];
    try {
      await import("@preload/entries/menu");
    } finally {
      process.argv = original;
    }

    // Only the freshly imported module's registrations.
    expect(exposed(before)).toEqual({
      menu: { wayland: true, submenu: false },
      inputRegion: { platform: process.platform },
    });
  });
});

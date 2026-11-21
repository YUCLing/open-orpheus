import { afterEach, describe, expect, it, vi } from "vitest";

// `exposeApi` reaches for `contextBridge`/`ipcRenderer`, so the bridge is faked.
const hoisted = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  bridgeExposeInMainWorld: vi.fn(),
  executeInMainWorld: vi.fn(({ func }: { func: () => void }) => func()),
  installPreloadPlugins: vi.fn(),
  pluginManagerRegistry: { load: {}, realm: "plugin-manager" },
}));

vi.mock("electron", () => ({
  contextBridge: {
    executeInMainWorld: hoisted.executeInMainWorld,
    exposeInMainWorld: hoisted.bridgeExposeInMainWorld,
  },
}));

vi.mock("../../src/preload/bridge", () => ({
  exposeApi: (prefix: string, values: Record<string, unknown> = {}) =>
    hoisted.exposeInMainWorld(prefix, values),
}));

vi.mock("@preload/bridge", () => ({
  exposeApi: (prefix: string, values: Record<string, unknown> = {}) =>
    hoisted.exposeInMainWorld(prefix, values),
}));

vi.mock("@preload/plugin", () => ({
  installPreloadPlugins: hoisted.installPreloadPlugins,
}));

vi.mock("../../src/preload/plugin/index", () => ({
  installPreloadPlugins: hoisted.installPreloadPlugins,
}));

vi.mock("virtual:open-orpheus/registry/plugin-manager", () => ({
  load: hoisted.pluginManagerRegistry.load,
  realm: hoisted.pluginManagerRegistry.realm,
}));

/** The prefixes exposed by the given module, in registration order. */
function exposed() {
  return Object.fromEntries(hoisted.exposeInMainWorld.mock.calls);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("window preload entry points", () => {
  it("exposes the API surface each window expects", async () => {
    vi.stubEnv("FLATPAK_ID", undefined);
    vi.stubGlobal("window", {});
    // Importing these modules is what registers the API surface. They are
    // imported here rather than at file scope because Vitest clears mock call
    // history before every test, which would wipe registrations made on import.
    await import("../../src/windows/desktop-lyrics");
    await import("../../src/windows/desktop-lyrics-preview");
    await import("../../src/windows/manage");
    await import("../../src/windows/menu");
    await import("../../src/windows/mini-player");
    await import("../../src/windows/plugin-manager");

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
      plugin: {
        platform: process.platform,
        versions: process.versions,
      },
    });
  });

  it("installs plugins in the plugin-manager preload with its own registry", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {});
    hoisted.installPreloadPlugins.mockClear();

    await import("../../src/windows/plugin-manager");

    expect(hoisted.installPreloadPlugins).toHaveBeenCalledWith(
      hoisted.pluginManagerRegistry.load,
      hoisted.pluginManagerRegistry.realm,
      expect.objectContaining({
        onControl: expect.any(Function),
        beforeDeactivate: expect.any(Function),
      })
    );
  });

  it("exposes the plugin-manager host bridge", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {});
    hoisted.bridgeExposeInMainWorld.mockClear();
    hoisted.installPreloadPlugins.mockClear();

    await import("../../src/windows/plugin-manager");

    const [name, bridge] = hoisted.bridgeExposeInMainWorld.mock.calls.at(-1)! as [
      string,
      import("@shared/contracts/plugin-configuration").PluginManagerHostBridge,
    ];
    expect(name).toBe("pluginManagerHost");

    const options = hoisted.installPreloadPlugins.mock.calls.at(-1)![2] as {
      onControl(control: {
        ready: Promise<void>;
        loader: { waitForSnapshot(id: string): Promise<unknown> };
      }): void;
      beforeDeactivate(id: string, desired: { enabled: boolean; revision: number }): unknown;
    };
    const waitForSnapshot = vi.fn().mockResolvedValue({ state: { kind: "running" } });
    options.onControl({ ready: Promise.resolve(), loader: { waitForSnapshot } });

    await expect(bridge.waitForRealm("p")).resolves.toEqual({ kind: "running" });
    expect(waitForSnapshot).toHaveBeenCalledWith("p");

    const dispose = vi.fn();
    bridge.setConfigurationHost({ dispose });
    await options.beforeDeactivate("p", { enabled: false, revision: 4 });
    expect(dispose).toHaveBeenCalledWith("p", 4);
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

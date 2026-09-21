import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/open-orpheus-test/${name}`),
  },
  BrowserWindow: vi.fn(),
  screen: { getDisplayMatching: vi.fn() },
}));

type WorkaroundModule = typeof import("@main/menu/workaround");

/** The enum type accepted by `workaroundEnabled`. */
type WorkaroundFlag = Parameters<WorkaroundModule["workaroundEnabled"]>[0];

/** Load the module with a controlled environment (its flags are set at import). */
async function loadWorkarounds(
  env: Record<string, string | undefined>
): Promise<WorkaroundModule> {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(name, "");
    else vi.stubEnv(name, value);
  }
  return await import("@main/menu/workaround");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workaround flags", () => {
  it("uses stable flags on a plain desktop", async () => {
    const { WorkaroundFlags, workaroundFlags } = await loadWorkarounds({
      XDG_CURRENT_DESKTOP: "GNOME",
    });

    expect(workaroundFlags).toBe(WorkaroundFlags.OverlayNoFullscreen);
  });

  it("keeps fullscreen on KDE", async () => {
    const { WorkaroundFlags, workaroundFlags } = await loadWorkarounds({
      XDG_CURRENT_DESKTOP: "KDE",
    });

    expect(workaroundFlags & WorkaroundFlags.OverlayNoFullscreen).toBe(0);
  });

  it("honours the KDE fullscreen opt-out", async () => {
    const { WorkaroundFlags, workaroundFlags } = await loadWorkarounds({
      XDG_CURRENT_DESKTOP: "KDE",
      MENU_OVERLAY_NO_FULLSCREEN: "1",
    });

    expect(workaroundFlags & WorkaroundFlags.OverlayNoFullscreen).not.toBe(0);
  });

  it("honours the fullscreen force flag", async () => {
    const { WorkaroundFlags, workaroundFlags } = await loadWorkarounds({
      XDG_CURRENT_DESKTOP: "GNOME",
      MENU_OVERLAY_FORCE_FULLSCREEN: "1",
    });

    expect(workaroundFlags & WorkaroundFlags.OverlayNoFullscreen).toBe(0);
  });

  it("disables maximize on niri", async () => {
    const { WorkaroundFlags, workaroundFlags } = await loadWorkarounds({
      XDG_CURRENT_DESKTOP: "niri",
    });

    expect(workaroundFlags & WorkaroundFlags.OverlayNoMaximize).not.toBe(0);
  });

  it("is not confused by a colon separated desktop list", async () => {
    const { WorkaroundFlags, workaroundFlags } = await loadWorkarounds({
      XDG_CURRENT_DESKTOP: "niri:KDE",
    });

    expect(workaroundFlags & WorkaroundFlags.OverlayNoFullscreen).toBe(0);
    expect(workaroundFlags & WorkaroundFlags.OverlayNoMaximize).not.toBe(0);
  });

  it("honours the extra maximize flags", async () => {
    const enabled = await loadWorkarounds({
      XDG_CURRENT_DESKTOP: "GNOME",
      MENU_OVERLAY_NO_MAXIMIZE: "true",
    });
    expect(
      enabled.workaroundFlags & enabled.WorkaroundFlags.OverlayNoMaximize
    ).not.toBe(0);

    const forced = await loadWorkarounds({
      XDG_CURRENT_DESKTOP: "niri",
      MENU_OVERLAY_FORCE_MAXIMIZE: "1",
    });
    expect(
      forced.workaroundFlags & forced.WorkaroundFlags.OverlayNoMaximize
    ).toBe(0);
  });
});

describe("workaroundEnabled", () => {
  it("tests a single flag", async () => {
    const { WorkaroundFlags, workaroundEnabled } = await loadWorkarounds({
      XDG_CURRENT_DESKTOP: "GNOME",
    });

    expect(workaroundEnabled(WorkaroundFlags.OverlayNoFullscreen)).toBe(true);
    expect(workaroundEnabled(WorkaroundFlags.OverlayNoMaximize)).toBe(false);
  });

  it("tests a combination of flags", async () => {
    const { WorkaroundFlags, workaroundEnabled } = await loadWorkarounds({
      XDG_CURRENT_DESKTOP: "niri",
    });

    const both =
      WorkaroundFlags.OverlayNoFullscreen | WorkaroundFlags.OverlayNoMaximize;

    expect(workaroundEnabled(both)).toBe(true);
    expect(workaroundEnabled(both & ~WorkaroundFlags.OverlayNoMaximize)).toBe(
      true
    );
    expect(workaroundEnabled(0 as WorkaroundFlag)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { whyNotALayerSurface } from "../../src/main/windows/desktop-lyrics-layer";

describe("which compositors the desktop lyrics take a layer surface on", () => {
  it.each(["niri", "NIRI", " Sway ", "sway", "river"])("follows a drag on %s", (desktop) => {
    expect(whyNotALayerSurface(desktop, undefined)).toBeNull();
  });

  it("reads the whole colon-separated name", () => {
    expect(whyNotALayerSurface("niri:something", undefined)).toBeNull();
    expect(whyNotALayerSurface("something:Sway", undefined)).toBeNull();
  });

  it.each(["KDE", "GNOME", "", "KDE:Plasma", "Hyprland", "labwc", "wayfire"])(
    "keeps an ordinary window on %s",
    (desktop) => {
      expect(whyNotALayerSurface(desktop, undefined)).toMatch(/pointer/);
    }
  );

  it("lets the variable ask for one anyway", () => {
    expect(whyNotALayerSurface("KDE", "1")).toBeNull();
    expect(whyNotALayerSurface("KDE", "true")).toBeNull();
  });

  it("lets the variable refuse one where they would be taken", () => {
    expect(whyNotALayerSurface("niri", "0")).toBe("asked not to");
    expect(whyNotALayerSurface("niri", "false")).toBe("asked not to");
  });

  it("leaves anything else to the compositor", () => {
    expect(whyNotALayerSurface("niri", "")).toBeNull();
    expect(whyNotALayerSurface("niri", "yes")).toBeNull();
    expect(whyNotALayerSurface("KDE", "yes")).toMatch(/pointer/);
  });
});

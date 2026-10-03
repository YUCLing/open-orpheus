import { describe, expect, it } from "vitest";
import { getOverlayPolicy } from "../../src/main/menu/overlay-policy";

describe("desktop-specific overlay policy", () => {
  it.each(["KDE", " KDE :plasma", "kde"])("arms before KDE window construction: %s", (desktop) => {
    expect(getOverlayPolicy(desktop)).toEqual({ platform: "kde", capturePhase: "before-create" });
  });
  it.each(["GNOME", "ubuntu:GNOME", "GNOME-Classic"])(
    "keeps GNOME show-time capture: %s",
    (desktop) => {
      expect(getOverlayPolicy(desktop)).toEqual({ platform: "gnome", capturePhase: "before-show" });
    }
  );
  it("keeps niri separate from GNOME", () => {
    expect(getOverlayPolicy("NIRI")).toEqual({ platform: "niri", capturePhase: "before-show" });
  });
  it.each(["", "sway", "Hyprland", "not-gnome"])("preserves legacy order for %s", (desktop) => {
    expect(getOverlayPolicy(desktop)).toEqual({ platform: "other", capturePhase: "before-create" });
  });
});

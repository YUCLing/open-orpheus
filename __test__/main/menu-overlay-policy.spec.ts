import { describe, expect, it } from "vitest";
import { getOverlayPolicy } from "@main/windows/menu/overlay-policy";

describe("desktop-specific overlay policy", () => {
  it.each(["KDE", " KDE :plasma", "kde"])("arms before KDE window construction: %s", (desktop) => {
    expect(getOverlayPolicy(desktop)).toEqual({ capturePhase: "before-create" });
  });
  it.each(["GNOME", "ubuntu:GNOME", "GNOME-Classic"])(
    "keeps GNOME show-time capture: %s",
    (desktop) => {
      expect(getOverlayPolicy(desktop)).toEqual({ capturePhase: "before-show" });
    }
  );
  it("arms niri capture before show", () => {
    expect(getOverlayPolicy("NIRI")).toEqual({ capturePhase: "before-show" });
  });
  it.each(["", "sway", "Hyprland", "not-gnome"])("preserves legacy order for %s", (desktop) => {
    expect(getOverlayPolicy(desktop)).toEqual({ capturePhase: "before-create" });
  });
});

import { checkEnvFlagPresent } from "../util";

export let workaroundFlags = 0;

export function workaroundEnabled(workaround: WorkaroundFlags) {
  return (workaroundFlags & workaround) !== 0;
}

export enum WorkaroundFlags {
  OverlayNoFullscreen = 1 << 0,
  OverlayNoMaximize = 1 << 1,
}

const de = process.env.XDG_CURRENT_DESKTOP
  ? process.env.XDG_CURRENT_DESKTOP.split(":")
  : [];

// Only KDE allows fullscreen transparent windows, see https://gitlab.freedesktop.org/wayland/wayland-protocols/-/issues/116
if (
  (!de.includes("KDE") || checkEnvFlagPresent("MENU_OVERLAY_NO_FULLSCREEN")) &&
  !checkEnvFlagPresent("MENU_OVERLAY_FORCE_FULLSCREEN")
) {
  workaroundFlags |= WorkaroundFlags.OverlayNoFullscreen;
}

// For niri (tiling wm), we need to disable maximize for floating rules to work
if (
  (de.includes("niri") || checkEnvFlagPresent("MENU_OVERLAY_NO_MAXIMIZE")) &&
  !checkEnvFlagPresent("MENU_OVERLAY_FORCE_MAXIMIZE")
) {
  workaroundFlags |= WorkaroundFlags.OverlayNoMaximize;
}

import { Display, screen } from "electron";
import {
  DesktopEnvironment,
  getDesktopEnvironment,
  getUniqueDisplayId,
} from "@open-orpheus/window";

// TODO: Stablized IDs for macOS and Windows

export function getDisplayUniqueId(display: Display): string {
  const de = getDesktopEnvironment();
  if (de === DesktopEnvironment.X11) return String(display.id);
  let id: string | null = null;
  if (de === DesktopEnvironment.Wayland) {
    id = getUniqueDisplayId(display.id);
    if (id) return id;
  }
  return String(display.id);
}

export function displayFromUniqueId(id: string | null): Display | null {
  if (!id) return null;
  return screen.getAllDisplays().find((v) => getDisplayUniqueId(v) === id) ?? null;
}

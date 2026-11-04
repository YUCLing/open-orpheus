import { Display, screen } from "electron";
import {
  DesktopEnvironment,
  getDesktopEnvironment,
  getUniqueDisplayId,
} from "@open-orpheus/window";

export function getDisplayUniqueId(display: Display): string {
  const de = getDesktopEnvironment();
  if (de === DesktopEnvironment.X11) return String(display.id);
  try {
    const id = getUniqueDisplayId(display.id);
    return id ?? String(display.id);
  } catch {
    return String(display.id);
  }
}

export function displayFromUniqueId(id: string | null): Display | null {
  if (!id) return null;
  return screen.getAllDisplays().find((v) => getDisplayUniqueId(v) === id) ?? null;
}

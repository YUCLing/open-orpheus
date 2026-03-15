import { BrowserWindow, screen } from "electron";
// eslint-disable-next-line import/no-unresolved
import { parseICO } from "icojs";
import { resolve, join, normalize } from "node:path";
import os from "node:os";

export async function pngFromIco(
  icoData: ArrayBuffer | Buffer<ArrayBufferLike>
): Promise<ArrayBuffer> {
  const images = await parseICO(icoData);
  if (images.length === 0) {
    throw new Error("No images found in ICO file");
  }
  const buf = Buffer.from(images[0].buffer);
  return buf.buffer;
}

export function sanitizeRelativePath(
  base: string,
  path: string
): string | false {
  const resolvedBase = resolve(base);
  const normalizedPath = normalize(path);
  const resolvedPath = resolve(
    join(
      resolvedBase,
      os.platform() === "win32"
        ? normalizedPath
        : normalizedPath.replaceAll("\\", "/")
    )
  );
  if (!resolvedPath.startsWith(resolvedBase)) {
    return false;
  }
  return resolvedPath;
}

export function getWindowState(
  wnd: BrowserWindow
): "minimize" | "maximize" | "restore" {
  return wnd.isMinimized()
    ? "minimize"
    : wnd.isMaximized()
      ? "maximize"
      : "restore";
}

export function getWindowSizeStatus(
  wnd: BrowserWindow
): ["minimize" | "maximize" | "restore", number, number, number] {
  const bounds = wnd.getBounds();
  const screenScaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
  // TODO: Confirm macOS desired behavior, Windows and Linux (Wayland) is already tested to be correct
  const scaleFactor = os.platform() === "win32" ? 1 : screenScaleFactor;
  return [
    getWindowState(wnd),
    bounds.width * scaleFactor,
    bounds.height * scaleFactor,
    screenScaleFactor,
  ];
}

export function getWindowScaleFactor(wnd: BrowserWindow): number {
  const bounds = wnd.getBounds();
  return screen.getDisplayMatching(bounds).scaleFactor;
}

import { resolve, join, normalize } from "node:path";
import { access, stat } from "node:fs/promises";
import os from "node:os";

import { BrowserWindow, screen } from "electron";
import photon from "@silvia-odwyer/photon-node";
import mime from "mime";
import { MetaPicture } from "music-tag-native";

export function pngFromIco(icoData: Uint8Array): Uint8Array {
  const icoImage = photon.PhotonImage.new_from_byteslice(icoData);
  const pngData = icoImage.get_bytes();
  return pngData;
}

export function normalizePath(...paths: string[]): string {
  return normalize(
    join(
      ...paths.map((path) =>
        os.platform() === "win32" ? path : path.replaceAll("\\", "/")
      )
    )
  );
}

export function sanitizeRelativePath(
  base: string,
  path: string
): string | false {
  const resolvedBase = resolve(base);
  const normalizedPath = normalizePath(path);
  const resolvedPath = resolve(join(resolvedBase, normalizedPath));
  if (!resolvedPath.startsWith(resolvedBase)) {
    return false;
  }
  return resolvedPath;
}

export function getWindowScaleFactor(wnd: BrowserWindow): number {
  const bounds = wnd.getBounds();
  return screen.getDisplayMatching(bounds).scaleFactor;
}

export function isMusicFile(fileOrPath: string): boolean {
  return mime.getType(fileOrPath)?.startsWith("audio/") || false;
}

export function isFileNotFound(err: unknown) {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * Asynchronous version of {@link existsSync}
 *
 * @param path Path to file
 */
export async function fileExists(path: string) {
  return await access(path)
    .then(() => true)
    .catch((err) => {
      if (isFileNotFound(err)) return false;
      throw err;
    });
}

export async function calculateDbSize(db: string): Promise<number> {
  const dbFile = resolve(db);
  const walFile = db + "-wal";
  const shmFile = db + "-shm";

  let sizeBytes = 0;

  await Promise.all([
    // Cannot fail
    stat(dbFile).then((v) => (sizeBytes += v.size)),
    // Failiable
    Promise.allSettled([
      stat(walFile).then((v) => (sizeBytes += v.size)),
      stat(shmFile).then((v) => (sizeBytes += v.size)),
    ]),
  ]);

  return sizeBytes;
}

export function selectBestMusicPic(pics: MetaPicture[]): MetaPicture | null {
  if (pics.length === 0) return null;
  let pic: MetaPicture | null = null;
  for (const p of pics) {
    // Use CoverFront directly
    if (p.coverType === "Cover Art (Front)") return p;
    // Use the first found if no CoverFront
    if (pic === null) pic = p;
  }
  return pic;
}

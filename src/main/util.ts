import { resolve, join, normalize, sep } from "node:path";
import { access, cp, mkdir, mkdtemp, rename, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";

import { BrowserWindow, screen } from "electron";
// TODO: consider defer the load of these modules? or move them away?
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
    join(...paths.map((path) => (os.platform() === "win32" ? path : path.replaceAll("\\", "/"))))
  );
}

export function sanitizeRelativePath(base: string, path: string): string | false {
  const resolvedBase = resolve(base);
  const normalizedPath = normalizePath(path);
  const resolvedPath = resolve(join(resolvedBase, normalizedPath));
  const baseWithSep = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(baseWithSep)) {
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

/**
 * Whether `path` exists and can actually be written to, tested by creating
 * (then removing) a uniquely named probe directory. When `create` is true the
 * directory is created first if it does not exist.
 *
 * @param path Path to the directory to test
 * @param create Whether to create the directory if it does not exist
 */
export async function isWritableDir(path: string, create = false): Promise<boolean> {
  try {
    if (create) await mkdir(path, { recursive: true });
    const probe = await mkdtemp(join(path, "open_orpheus_test_writable_"));
    await rm(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
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

export function checkEnvFlagPresent(name: string) {
  const val = process.env[name];
  return val === "1" || val === "true";
}

/**
 * Whether a URL safe internal app URL.
 */
export function isAppUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "orpheus:" && hostname === "orpheus";
  } catch {
    return false;
  }
}

/**
 * Try move file or folder with the least efforts.
 */
export async function move(src: string | URL, dest: string | URL) {
  try {
    await rename(src, dest);
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "EXDEV") {
      // The file/folder is being moved across the devices.
      await cp(src, dest, { recursive: true });
      await rm(src, { recursive: true, force: true });
      return;
    }
    throw e;
  }
}

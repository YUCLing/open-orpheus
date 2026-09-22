import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import mime from "mime";
import { MusicFile } from "music-tag-native";

import { imageSize } from "@shared/util";
import { cache } from "../../folders";
import { selectBestMusicPic } from "../../util";

/**
 * Album-art handling shared by the media-session integrations (MPRIS / SMTC /
 * Now Playing).
 *
 * The renderer reports album art per song through `player.setCover`. Online
 * tracks give a remote http(s) URL; local tracks give an
 * `orpheus://localmusic/pic?<path>` URL pointing at the app's embedded-art
 * endpoint. OS media sessions cannot load `orpheus://` URLs, so local covers
 * are extracted and cached as a local image file; the resulting `file://` URL
 * is what flows to the adapters.
 */

/** Directory where resolved album art is cached as plain image files. */
export const ART_CACHE_DIR = join(cache, "thumbnails");

/** Keep the album-art cache bounded (oldest entries are evicted). */
const MAX_ART_CACHE = 3;

/** Absolute path of the cached artwork file for a track. */
export function artworkCachePath(id: string, ext: string): string {
  return join(ART_CACHE_DIR, `${id}${ext}`);
}

/** `file://` URL of the cached artwork file for a track. */
export function artworkFileUrl(id: string, ext: string): string {
  return pathToFileURL(artworkCachePath(id, ext)).toString();
}

/** Whether the artwork for a track is already cached. */
export async function artworkFileExists(
  id: string,
  ext: string
): Promise<boolean> {
  try {
    await stat(artworkCachePath(id, ext));
    return true;
  } catch {
    return false;
  }
}

/** Extension (with dot) derived from a remote artwork URL, defaulting to `.jpg`. */
export function remoteArtExt(url: string): string {
  try {
    return extname(new URL(url).pathname) || ".jpg";
  } catch {
    return ".jpg";
  }
}

/** Extension (with dot) for a picture MIME type, defaulting to `.jpg`. */
function artExtForMime(mimeType: string | undefined): string {
  if (mimeType) {
    const ext = mime.getExtension(mimeType);
    if (ext) return `.${ext}`;
  }
  return ".jpg";
}

/**
 * Write bytes into the album-art cache and return the `file://` URL. No-op
 * (returns the URL) when the file is already present.
 */
export async function cacheArtwork(
  id: string,
  data: Uint8Array,
  ext: string
): Promise<string> {
  const path = artworkCachePath(id, ext);
  try {
    await stat(path);
    return artworkFileUrl(id, ext);
  } catch {
    /* not cached yet */
  }
  await mkdir(ART_CACHE_DIR, { recursive: true });
  await writeFile(path, data);
  await pruneArtCache();
  return artworkFileUrl(id, ext);
}

/**
 * Evict the oldest cached artwork files so the cache stays bounded at
 * `MAX_ART_CACHE`. Called after each new file is written; the fresh file is the
 * most recent and is always kept.
 */
async function pruneArtCache(): Promise<void> {
  try {
    const entries = await readdir(ART_CACHE_DIR, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((e) => e.isFile())
        .map(async (e) => {
          const { mtimeMs } = await stat(join(ART_CACHE_DIR, e.name));
          return { name: e.name, mtimeMs };
        })
    );
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const stale = files.slice(0, Math.max(0, files.length - MAX_ART_CACHE));
    await Promise.all(stale.map((f) => unlink(join(ART_CACHE_DIR, f.name))));
  } catch {
    // Ignore pruning failures — the cache just grows until next time.
  }
}

/**
 * Extract the embedded album picture behind an `orpheus://localmusic/pic?<path>`
 * cover URL and cache it as a local file. Returns a `file://` URL, or null when
 * the URL isn't one of ours or the file has no usable embedded picture.
 */
export async function resolveEmbeddedArtwork(
  rawUrl: string,
  trackId: string
): Promise<string | null> {
  if (!rawUrl.startsWith("orpheus://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== "localmusic" || parsed.pathname !== "/pic") {
    return null;
  }
  // Mirrors the `orpheus://localmusic/pic` handler in `orpheus.ts`: the query
  // string is the percent-encoded file path.
  const filePath = decodeURIComponent(parsed.search.substring(1));
  if (!filePath) return null;
  try {
    const taggedFile = await MusicFile.load(filePath);
    const pictures = taggedFile.pictures;
    const pic = pictures ? selectBestMusicPic(pictures) : null;
    if (!pic) return null;
    return await cacheArtwork(trackId, pic.data, artExtForMime(pic.mimeType));
  } catch {
    return null;
  }
}

/**
 * Resolve a raw cover URL (from `player.setCover`) into a URL the OS media
 * sessions can consume:
 *  - http(s) / file URLs pass through unchanged;
 *  - `orpheus://localmusic/pic?<path>` covers are extracted to a local `file://`
 *    file;
 *  - anything else resolves to "" (no art).
 */
export async function resolveCoverUrl(
  rawUrl: string | null,
  trackId: string
): Promise<string> {
  if (!rawUrl) return "";
  if (/^https?:\/\//i.test(rawUrl) || rawUrl.startsWith("file://")) {
    return rawUrl;
  }
  return (await resolveEmbeddedArtwork(rawUrl, trackId)) ?? "";
}

/**
 * A URL suitable for a native media session (SMTC / Now Playing). Remote
 * http(s) covers are requested as a small square; already-local art and other
 * URLs pass through unchanged.
 */
export function nativeArtUrl(url: string): string {
  if (!url || url.startsWith("file://") || url.startsWith("data:")) return url;
  try {
    return imageSize(url, 512);
  } catch {
    return url;
  }
}

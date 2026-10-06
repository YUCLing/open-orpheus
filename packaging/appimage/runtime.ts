import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * AppImage type-2 runtime resolution.
 *
 * An AppImage is the concatenation of a type-2 runtime (an ELF launcher which
 * mounts/extracts the appended filesystem and executes `AppRun`) and a
 * SquashFS image. The runtime is architecture-specific and, unlike
 * `appimagetool`, is not installed by any distribution package — so it is
 * fetched once from the official releases and cached.
 */

/** Official AppImage `type2-runtime` release (contains `runtime-<arch>` assets). */
export const APPIMAGE_RUNTIME_MIRROR =
  "https://github.com/AppImage/type2-runtime/releases/download/continuous";

/** URL of the official runtime for an AppImage arch name (e.g. `x86_64`). */
export function runtimeUrl(arch: string): string {
  return `${APPIMAGE_RUNTIME_MIRROR}/runtime-${arch}`;
}

export interface RuntimeOptions {
  /** Project root: relative `runtime` paths and the cache live here. */
  projectRoot: string;
  /** AppImage arch name (e.g. `x86_64`), used by the default URL. */
  arch: string;
  /** Runtime file path or `http(s)` URL. Defaults to `$APPIMAGE_RUNTIME`, then the official release. */
  runtime?: string | undefined;
  /** Expected SHA-256 (hex, optionally `sha256:` prefixed). */
  checksum?: string | undefined;
}

/** ELF magic (`\x7fELF`), the only thing a type-2 runtime can start with. */
const ELF_MAGIC = 0x7f454c46;

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const isUrl = (source: string) => /^https?:\/\//i.test(source);

/** The expected digest in lower-case hex, without an optional `sha256:` prefix. */
function expectedDigest(checksum: string | undefined): string | undefined {
  return (
    checksum
      ?.replace(/^sha256:/i, "")
      .trim()
      .toLowerCase() || undefined
  );
}

/** Verify an ELF magic and, when given, the SHA-256 digest. Returns `data`. */
function verify(data: Buffer, source: string, digest?: string): Buffer {
  if (digest && sha256(data) !== digest) {
    throw new Error(`AppImage runtime checksum mismatch for '${source}'.`);
  }
  if (data.length < 4 || data.readUInt32BE(0) !== ELF_MAGIC) {
    throw new Error(`Not an ELF binary (an AppImage type-2 runtime is expected): '${source}'.`);
  }
  return data;
}

/**
 * Resolve the AppImage type-2 runtime to prepend.
 *
 * Local paths are read as-is; remote runtimes are cached in
 * `out/.cache/appimage/` (git-ignored) so repeated and offline builds reuse the
 * download. The cache is keyed by source URL and architecture, so pointing at a
 * different runtime never reuses (or overwrites) an unrelated download; a cached
 * file that does not match the requested checksum is refreshed.
 */
export async function resolveRuntime(options: RuntimeOptions): Promise<Buffer> {
  const source = options.runtime ?? process.env["APPIMAGE_RUNTIME"] ?? runtimeUrl(options.arch);
  const digest = expectedDigest(options.checksum);

  if (!isUrl(source)) {
    const path = resolve(options.projectRoot, source);
    if (!existsSync(path)) {
      throw new Error(`AppImage runtime not found: '${path}'.`);
    }
    return verify(await readFile(path), path, digest);
  }

  // The URL is part of the key: `runtime-<arch>` alone would hand the cached
  // bytes of one mirror to a build that asked for another.
  const cachePath = resolve(
    options.projectRoot,
    "out/.cache/appimage",
    `runtime-${options.arch}-${sha256(source).slice(0, 16)}`
  );
  if (existsSync(cachePath)) {
    const cached = await readFile(cachePath);
    // A stale/invalid cache entry is not fatal: fall through and re-download.
    if (!digest || sha256(cached) === digest) {
      try {
        return verify(cached, cachePath);
      } catch {
        // Ignore and re-download below.
      }
    }
  }

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(
      `Failed to download the AppImage runtime (${response.status} ${response.statusText}): '${source}'.`
    );
  }
  const data = verify(Buffer.from(await response.arrayBuffer()), source, digest);

  await mkdir(dirname(cachePath), { recursive: true });
  // Write-then-rename: an interrupted build never leaves a truncated cache entry.
  // The temp name is unique per download, so two builds of the same arch cannot
  // rename (or overwrite) each other's half-written file.
  const tmp = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, cachePath);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return data;
}

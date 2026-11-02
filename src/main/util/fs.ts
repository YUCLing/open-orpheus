import { join, resolve } from "node:path";
import { access, cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";

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

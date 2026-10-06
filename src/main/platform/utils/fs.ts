import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";

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

import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * Create a gzipped tarball of the project source.
 *
 * The tarball contains exactly the files that are NOT ignored by `.gitignore`
 * — tracked files plus untracked-but-not-ignored files (via
 * `git ls-files --cached --others --exclude-standard`) — under a single
 * top-level directory `<name>-<version>/`. `excludePaths` may drop additional
 * directory prefixes (relative to `projectRoot`).
 */
export async function createProjectTarball(
  projectRoot: string,
  dest: string,
  name: string,
  version: string,
  excludePaths: string[] = []
) {
  // Files that are tracked in the index but deleted from the working tree
  // without being staged (`git rm`) still show up in `--cached` yet no longer
  // exist on disk — drop them or tar fails with "Cannot stat".
  const [{ stdout: nullSeparatedFiles }, { stdout: deletedFiles }] =
    await Promise.all([
      execFile(
        "git",
        [
          "-C",
          projectRoot,
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ],
        { maxBuffer: 10 * 1024 * 1024 }
      ),
      execFile("git", ["-C", projectRoot, "ls-files", "--deleted", "-z"], {
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);
  const deleted = new Set(deletedFiles.split("\0").filter(Boolean));

  const filtered = nullSeparatedFiles
    .split("\0")
    .filter((f) => {
      if (!f || deleted.has(f)) return false;
      return !excludePaths.some((p) => f === p || f.startsWith(p + "/"));
    })
    .join("\0");

  await new Promise<void>((res, rej) => {
    const tar = spawn(
      "tar",
      [
        "czf",
        dest,
        "--null",
        "--no-recursion",
        "--transform",
        `s,^,${name}-${version}/,`,
        "-C",
        projectRoot,
        "-T",
        "-",
      ],
      { cwd: projectRoot }
    );
    tar.on("error", rej);
    tar.on("close", (code) =>
      code === 0 ? res() : rej(new Error(`tar exited with code ${code}`))
    );
    tar.stdin.end(filtered);
  });
}

/**
 * Tar the contents of `srcDir` into `dest` at the archive root (no wrapping
 * directory). Used to bundle the prebuilt Flatpak payload (app/, scaffold/,
 * metainfo) from a staging dir.
 */
export async function createDirectoryTarball(srcDir: string, dest: string) {
  await new Promise<void>((res, rej) => {
    const tar = spawn("tar", ["czf", dest, "-C", srcDir, "."]);
    tar.on("error", rej);
    tar.on("close", (code) =>
      code === 0 ? res() : rej(new Error(`tar exited with code ${code}`))
    );
  });
}

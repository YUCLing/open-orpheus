import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create as createTar } from "tar";

import {
  captureDependency,
  deployTarball,
  readSnapshotEntries,
  restoreDependencies,
  snapshotDirs,
  type SnapshotDirs,
} from "../../scripts/deploy-deps";

/**
 * The snapshot directory is the whole state, so these tests drive the real functions against a
 * throwaway `node_modules` and assert on the filesystem — there is no index to keep in step.
 */

let root: string;
let dirs: SnapshotDirs;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "deploy-deps-spec-"));
  dirs = snapshotDirs(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const live = (name: string) => resolve(dirs.nodeModulesDir, name);
const payload = (name: string) => resolve(dirs.snapshotDir, name);
const marker = (name: string) => resolve(dirs.snapshotDir, ".absent", name);

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false
  );

const read = (path: string) => readFile(path, "utf-8");

/** A workspace link, as `pnpm install` creates it. */
async function makeLink(name: string, target: string) {
  await mkdir(dirname(live(name)), { recursive: true });
  await symlink(target, live(name));
}

/** What a previous deploy leaves behind at `name`. */
async function makeDeployment(name: string, contents = "deployed") {
  await mkdir(live(name), { recursive: true });
  await writeFile(join(live(name), "deployed.txt"), contents);
}

describe("captureDependency", () => {
  it("moves a workspace link into the snapshot, target intact", async () => {
    await makeLink("@scope/pkg", "../pkg-source");

    const entry = await captureDependency(dirs, "@scope/pkg");

    expect(entry).toEqual({ path: "@scope/pkg", kind: "symlink", target: "../pkg-source" });
    expect(await exists(live("@scope/pkg"))).toBe(false);
    expect(await readlink(payload("@scope/pkg"))).toBe("../pkg-source");
  });

  it("moves a real directory into the snapshot without losing its files", async () => {
    await mkdir(live("pkg"), { recursive: true });
    await writeFile(join(live("pkg"), "index.js"), "original");

    const entry = await captureDependency(dirs, "pkg");

    expect(entry.kind).toBe("directory");
    await expect(read(join(payload("pkg"), "index.js"))).resolves.toBe("original");
    expect(await exists(live("pkg"))).toBe(false);
  });

  it("records an absent dependency as a marker instead of a payload", async () => {
    const entry = await captureDependency(dirs, "@open-orpheus/dbus");

    expect(entry).toEqual({ path: "@open-orpheus/dbus", kind: "absent" });
    expect(await exists(marker("@open-orpheus/dbus"))).toBe(true);
    expect(await exists(payload("@open-orpheus/dbus"))).toBe(false);
  });

  it("keeps the captured state when the deploy is repeated", async () => {
    await makeLink("pkg", "../pkg-source");
    await captureDependency(dirs, "pkg");
    // A previous deploy extracted over the link; the snapshot still holds the original.
    await makeDeployment("pkg");

    const entry = await captureDependency(dirs, "pkg");

    expect(entry).toEqual({ path: "pkg", kind: "symlink", target: "../pkg-source" });
    expect(await readlink(payload("pkg"))).toBe("../pkg-source");
    expect(await exists(live("pkg"))).toBe(false);
    expect(await readSnapshotEntries(dirs)).toEqual([
      { path: "pkg", kind: "symlink", target: "../pkg-source" },
    ]);
  });

  it("keeps an absent record when the deploy is repeated", async () => {
    await captureDependency(dirs, "@open-orpheus/dbus");
    // The first deploy extracted into a path that did not exist before.
    await makeDeployment("@open-orpheus/dbus");

    const entry = await captureDependency(dirs, "@open-orpheus/dbus");

    // The deployment must not be adopted as the "original" (it would survive `--restore`).
    expect(entry).toEqual({ path: "@open-orpheus/dbus", kind: "absent" });
    expect(await exists(payload("@open-orpheus/dbus"))).toBe(false);
    expect(await exists(marker("@open-orpheus/dbus"))).toBe(true);
  });

  it("rejects names that would escape the snapshot or shadow its state", async () => {
    await expect(captureDependency(dirs, "../outside")).rejects.toThrow(/Unsafe package name/);
    await expect(captureDependency(dirs, "a/../b")).rejects.toThrow(/Unsafe package name/);
    // `.absent` holds the markers, so a dot-prefixed package name cannot be represented.
    await expect(captureDependency(dirs, ".absent")).rejects.toThrow(/Unsafe package name/);
  });
});

describe("readSnapshotEntries", () => {
  it("reads payloads and absent markers, and skips a legacy index", async () => {
    await makeLink("pkg", "../pkg-source");
    await captureDependency(dirs, "pkg");
    await captureDependency(dirs, "@open-orpheus/dbus");
    await writeFile(join(dirs.snapshotDir, "index.json"), "{}");

    const entries = await readSnapshotEntries(dirs);

    expect(entries).toContainEqual({ path: "pkg", kind: "symlink", target: "../pkg-source" });
    expect(entries).toContainEqual({ path: "@open-orpheus/dbus", kind: "absent" });
    expect(entries.map((entry) => entry.path)).not.toContain("index.json");
  });
});

describe("restoreDependencies", () => {
  it("puts a captured link back and removes the snapshot", async () => {
    await makeLink("pkg", "../pkg-source");
    await captureDependency(dirs, "pkg");
    await makeDeployment("pkg");

    expect(await restoreDependencies(dirs)).toBe(0);

    expect(await readlink(live("pkg"))).toBe("../pkg-source");
    expect(await exists(dirs.snapshotDir)).toBe(false);
  });

  it("removes the deployment of a dependency that did not exist", async () => {
    await captureDependency(dirs, "@open-orpheus/dbus");
    await makeDeployment("@open-orpheus/dbus");

    expect(await restoreDependencies(dirs)).toBe(0);

    expect(await exists(live("@open-orpheus/dbus"))).toBe(false);
    expect(await exists(dirs.snapshotDir)).toBe(false);
  });

  it("leaves a link that was installed after the snapshot alone", async () => {
    await makeLink("pkg", "../pkg-source");
    await captureDependency(dirs, "pkg");
    await rm(live("pkg"), { recursive: true, force: true });
    await makeLink("pkg", "../fresh-install");

    expect(await restoreDependencies(dirs)).toBe(0);

    expect(await readlink(live("pkg"))).toBe("../fresh-install");
    expect(await exists(dirs.snapshotDir)).toBe(false);
  });

  it("does not touch anything when there is no snapshot", async () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await restoreDependencies(dirs)).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("survives a restore that was interrupted after moving a payload back", async () => {
    await makeLink("pkg", "../pkg-source");
    await captureDependency(dirs, "pkg");
    // Simulate the interruption: the payload is already back, so the snapshot holds nothing for it.
    await rename(payload("pkg"), live("pkg"));

    expect(await restoreDependencies(dirs)).toBe(0);

    expect(await readlink(live("pkg"))).toBe("../pkg-source");
    expect(await exists(dirs.snapshotDir)).toBe(false);
  });

  it("is idempotent", async () => {
    await captureDependency(dirs, "@open-orpheus/dbus");
    await makeDeployment("@open-orpheus/dbus");

    expect(await restoreDependencies(dirs)).toBe(0);
    expect(await restoreDependencies(dirs)).toBe(0);

    expect(await exists(live("@open-orpheus/dbus"))).toBe(false);
  });
});

describe("deployTarball", () => {
  it("extracts a packed module over the path it captured, and restores it", async () => {
    const staging = join(root, "_staging", "package");
    await mkdir(staging, { recursive: true });
    await writeFile(
      join(staging, "package.json"),
      JSON.stringify({ name: "pkg", version: "1.0.0" })
    );
    await writeFile(join(staging, "index.js"), "module.exports = 1;");
    const tarball = join(root, "pkg-1.0.0.tgz");
    await createTar({ gzip: true, file: tarball, cwd: join(root, "_staging") }, ["package"]);
    await makeLink("pkg", "../pkg-source");

    await deployTarball(dirs, tarball);

    await expect(read(join(live("pkg"), "index.js"))).resolves.toBe("module.exports = 1;");
    // The link that was replaced is still the pre-deploy state.
    expect(await readlink(payload("pkg"))).toBe("../pkg-source");

    expect(await restoreDependencies(dirs)).toBe(0);
    expect(await readlink(live("pkg"))).toBe("../pkg-source");
  });
});

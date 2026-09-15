import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: hoisted.execFile,
  spawn: hoisted.spawn,
}));

import {
  createDirectoryTarball,
  createProjectTarball,
} from "../../packaging/common/archive";

type FakeChild = EventEmitter & { stdin: { end: ReturnType<typeof vi.fn> } };

/** Make the two `git ls-files` calls return the given NUL-separated lists. */
function gitReturns(files: string[], deleted: string[] = []) {
  hoisted.execFile.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (error: Error | null, result?: { stdout: string }) => void
    ) => {
      const stdout = args.includes("--deleted")
        ? deleted.join("\0")
        : files.join("\0");
      cb(null, { stdout });
      return {} as never;
    }
  );
}

/** Queue the child process the next `tar` spawn returns. */
function nextTar(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = { end: vi.fn() };
  hoisted.spawn.mockReturnValueOnce(child);
  return child;
}

/** The file list handed to tar on stdin. */
function tarInput(child: FakeChild) {
  return String(child.stdin.end.mock.calls[0][0]).split("\0");
}

/** Let the `git ls-files` calls settle so tar has been spawned. */
const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  hoisted.execFile.mockReset();
  hoisted.spawn.mockReset();
});

describe("createProjectTarball", () => {
  it("asks git for the file list and pipes it into tar", async () => {
    gitReturns(["package.json", "src/main.ts"]);
    const child = nextTar();

    const promise = createProjectTarball(
      "/repo",
      "/out/project.tar.gz",
      "open-orpheus",
      "0.17.1"
    );
    await settle();

    expect(hoisted.execFile.mock.calls.map(([, args]) => args)).toEqual([
      [
        "-C",
        "/repo",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      ["-C", "/repo", "ls-files", "--deleted", "-z"],
    ]);
    expect(hoisted.spawn).toHaveBeenCalledWith(
      "tar",
      [
        "czf",
        "/out/project.tar.gz",
        "--null",
        "--no-recursion",
        "--transform",
        "s,^,open-orpheus-0.17.1/,",
        "-C",
        "/repo",
        "-T",
        "-",
      ],
      { cwd: "/repo" }
    );
    expect(tarInput(child)).toEqual(["package.json", "src/main.ts"]);

    child.emit("close", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("drops files that are staged but deleted from the working tree", async () => {
    gitReturns(["kept.ts", "gone.ts"], ["gone.ts"]);
    const child = nextTar();

    const promise = createProjectTarball("/repo", "/out/a.tgz", "app", "1.0.0");
    await settle();

    expect(tarInput(child)).toEqual(["kept.ts"]);

    child.emit("close", 0);
    await promise;
  });

  it("drops excluded paths and their contents", async () => {
    gitReturns([
      "packaging/resources/debian/control.ejs",
      "packaging/resources/debian/rules.ejs",
      "packaging/resources/misc/file",
      "packaging/options.ts",
    ]);
    const child = nextTar();

    const promise = createProjectTarball(
      "/repo",
      "/out/a.tgz",
      "app",
      "1.0.0",
      ["packaging/resources/debian"]
    );
    await settle();

    expect(tarInput(child)).toEqual([
      "packaging/resources/misc/file",
      "packaging/options.ts",
    ]);

    child.emit("close", 0);
    await promise;
  });

  it("ignores empty entries", async () => {
    gitReturns(["a.ts", "", "b.ts"]);
    const child = nextTar();

    const promise = createProjectTarball("/repo", "/out/a.tgz", "app", "1.0.0");
    await settle();

    expect(tarInput(child)).toEqual(["a.ts", "b.ts"]);

    child.emit("close", 0);
    await promise;
  });

  it("prefixes the archive with name and version", async () => {
    gitReturns(["a.ts"]);
    const child = nextTar();

    const promise = createProjectTarball(
      "/repo",
      "/out/a.tgz",
      "my-app",
      "2.3.4"
    );
    await settle();

    expect(hoisted.spawn.mock.calls[0][1]).toContain("s,^,my-app-2.3.4/,");

    child.emit("close", 0);
    await promise;
  });

  it("rejects when tar fails", async () => {
    gitReturns(["a.ts"]);
    const child = nextTar();

    const promise = createProjectTarball("/repo", "/out/a.tgz", "app", "1.0.0");
    await settle();

    child.emit("close", 1);

    await expect(promise).rejects.toThrow("tar exited with code 1");
  });

  it("rejects when tar cannot be spawned", async () => {
    gitReturns(["a.ts"]);
    const child = nextTar();

    const promise = createProjectTarball("/repo", "/out/a.tgz", "app", "1.0.0");
    await settle();

    child.emit("error", new Error("spawn tar ENOENT"));

    await expect(promise).rejects.toThrow("spawn tar ENOENT");
  });
});

describe("createDirectoryTarball", () => {
  it("tars the directory contents at the archive root", async () => {
    const child = nextTar();

    const promise = createDirectoryTarball("/stage/payload", "/out/app.tar.gz");

    expect(hoisted.spawn).toHaveBeenCalledWith("tar", [
      "czf",
      "/out/app.tar.gz",
      "-C",
      "/stage/payload",
      ".",
    ]);

    child.emit("close", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects on a non-zero exit", async () => {
    const child = nextTar();

    const promise = createDirectoryTarball("/stage/payload", "/out/app.tar.gz");

    child.emit("close", 2);

    await expect(promise).rejects.toThrow("tar exited with code 2");
  });

  it("writes to the requested destination", async () => {
    const child = nextTar();

    const promise = createDirectoryTarball("/stage/payload", "/out/payload.gz");

    expect(hoisted.spawn.mock.calls[0][1][1]).toBe("/out/payload.gz");

    child.emit("close", 0);
    await promise;
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  electronApp: { isPackaged: false },
}));

vi.mock("electron", () => ({ app: hoisted.electronApp }));

import {
  parseLocalFile,
  parseMoveRun,
  parseWebCommand,
  raceArgument,
} from "@main/platform/arguments";

/**
 * `parseLocalFile` imports the real checks, so these tests use a real tree of
 * files rather than fakes. It runs with the temp directory as the working
 * directory, which keeps the assertions about *relative* paths honest — and it
 * is the only way to test the property that matters most here: the disk probe is
 * genuinely asynchronous, which is why a local file loses the race in
 * `raceArgument` to a URL that matches synchronously.
 */
let fixtureDir: string;
let previousCwd: string;

const MUSIC = ["song.mp3", "music/album/song.mp3", "music/song.mp3"];

beforeEach(async () => {
  hoisted.electronApp.isPackaged = false;
  fixtureDir = await mkdtemp(join(tmpdir(), "open-orpheus-args-"));
  for (const relative of MUSIC) {
    const target = join(fixtureDir, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "");
  }
  // Exists, but is not music; and a directory, which is not music either.
  await writeFile(join(fixtureDir, "cover.jpg"), "");
  await mkdir(join(fixtureDir, "music-dir"), { recursive: true });
  previousCwd = process.cwd();
  process.chdir(fixtureDir);
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(fixtureDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("raceArgument", () => {
  it("returns the first argument the predicate accepts", async () => {
    const result = await raceArgument(
      (arg) => (arg.startsWith("--") ? arg : null),
      ["file.mp3", "--moverun", "--other"]
    );

    expect(result).toBe("--moverun");
  });

  it("resolves the value the predicate returns, not the argument", async () => {
    const result = await raceArgument(
      (arg) => (arg === "second" ? { index: 2 } : null),
      ["first", "second", "third"]
    );

    expect(result).toEqual({ index: 2 });
  });

  it("returns null when nothing matches", async () => {
    await expect(raceArgument(() => null, ["a", "b"])).resolves.toBeNull();
    await expect(raceArgument(() => null, [])).resolves.toBeNull();
  });

  it("awaits asynchronous predicates", async () => {
    const result = await raceArgument(
      async (arg) => (arg === "music.mp3" ? arg.toUpperCase() : null),
      ["notes.txt", "music.mp3"]
    );

    expect(result).toBe("MUSIC.MP3");
  });

  it("returns null when the predicate rejects", async () => {
    const error = new Error("boom");

    await expect(
      raceArgument(() => {
        throw error;
      }, ["a"])
    ).resolves.toBeNull();
  });

  it("reads the process argv while unpackaged", async () => {
    // Two leading entries are the electron executable and the main script.
    vi.stubGlobal("process", {
      ...process,
      argv: ["electron", ".", "--moverun", "src", "dest"],
    });

    const seen: string[] = [];
    const result = await raceArgument((arg) => {
      seen.push(arg);
      return arg === "--moverun" ? "--moverun" : null;
    });

    expect(seen).toEqual(["--moverun", "src", "dest"]);
    expect(result).toBe("--moverun");
  });

  it("keeps the package argument while packaged", async () => {
    hoisted.electronApp.isPackaged = true;

    vi.stubGlobal("process", {
      ...process,
      argv: ["/opt/open-orpheus/open-orpheus", "song.mp3"],
    });

    const seen: string[] = [];
    await raceArgument((arg) => {
      seen.push(arg);
      return arg;
    });

    expect(seen).toEqual(["song.mp3"]);
  });
});

describe("parseWebCommand", () => {
  it("accepts the orpheus scheme", () => {
    expect(parseWebCommand("orpheus://song/123")).toBe("orpheus://song/123");
    expect(parseWebCommand("orpheus://")).toBe("orpheus://");
  });

  it("rejects anything else", () => {
    expect(parseWebCommand("https://music.163.com/song/123")).toBeNull();
    expect(parseWebCommand("notorpheus://x")).toBeNull();
    expect(parseWebCommand("--moverun")).toBeNull();
    expect(parseWebCommand("")).toBeNull();
  });
});

describe("parseMoveRun", () => {
  it("reads the source and destination of a --moverun command", () => {
    expect(parseMoveRun("--moverun", 0, ["--moverun", "src", "dest"])).toEqual(["src", "dest"]);
  });

  it("ignores a --moverun without both operands", () => {
    expect(parseMoveRun("--moverun", 0, ["--moverun", "src"])).toBeNull();
    expect(parseMoveRun("--moverun", 0, ["--moverun"])).toBeNull();
  });

  it("ignores other arguments", () => {
    expect(parseMoveRun("orpheus://x", 0, ["orpheus://x", "src", "dest"])).toBeNull();
    expect(parseMoveRun("src", 1, ["--moverun", "src", "dest"])).toBeNull();
  });
});

describe("parseLocalFile", () => {
  it("returns the normalised path of an existing music file", async () => {
    // The file exists only at the normalised path, so resolving to it is proof
    // the disk probe ran and succeeded.
    await expect(parseLocalFile("song.mp3")).resolves.toBe("song.mp3");
    await expect(parseLocalFile("music/album/song.mp3")).resolves.toBe(
      normalize("music/album/song.mp3")
    );
  });

  it("normalises the path before checking it", async () => {
    // `music/./album/../song.mp3` is created as `music/song.mp3`, and the value
    // that comes back is normalised — so normalisation precedes the probe.
    await expect(parseLocalFile("music/./album/../song.mp3")).resolves.toBe(
      normalize("music/song.mp3")
    );
  });

  it("rejects paths that are not music files", async () => {
    // `cover.jpg` is a real file: it is rejected for what it is, not because it
    // is missing.
    await expect(parseLocalFile("cover.jpg")).resolves.toBeNull();
    await expect(parseLocalFile("no-extension")).resolves.toBeNull();
  });

  it("rejects music files that do not exist on disk", async () => {
    await expect(parseLocalFile("missing.mp3")).resolves.toBeNull();
  });

  it("rejects an empty argument", async () => {
    // "." is not a music file.
    await expect(parseLocalFile("")).resolves.toBeNull();
  });

  it("checks every argument on its own", async () => {
    // A directory and a path that does not exist; each argument is judged alone
    // rather than joined into one path.
    await expect(parseLocalFile("music-dir")).resolves.toBeNull();
    await expect(parseLocalFile("my album")).resolves.toBeNull();
    await expect(parseLocalFile("song.mp3")).resolves.toBe("song.mp3");
  });
});

describe.runIf(process.platform === "win32")("parseLocalFile on Windows", () => {
  it("converts forward slashes to backslashes", async () => {
    await expect(parseLocalFile("music/album/song.mp3")).resolves.toBe("music\\album\\song.mp3");
  });
});

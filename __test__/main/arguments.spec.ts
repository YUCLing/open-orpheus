import { normalize } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The arguments module only needs `fileExists` and `isMusicFile` from
// `util.ts`; the rest of that module pulls in Electron and native image
// helpers, so the two seams are faked here instead.
const hoisted = vi.hoisted(() => ({
  fileExists: vi.fn<(path: string) => Promise<boolean>>(),
  // Replaced with a real matcher in `beforeEach`.
  isMusicFile: vi.fn((path: string) => path.length > 0),
  electronApp: { isPackaged: false },
}));

vi.mock("../../src/main/util", () => ({
  fileExists: hoisted.fileExists,
  isMusicFile: hoisted.isMusicFile,
}));

vi.mock("electron", () => ({ app: hoisted.electronApp }));

import {
  parseLocalFile,
  parseMoveRun,
  parseWebCommand,
  raceArgument,
} from "../../src/main/arguments";

/** Stand-in for the real mime lookup used by `isMusicFile`. */
function looksLikeMusicFile(path: string) {
  return /\.(mp3|flac|wav|m4a|ogg|opus|aac)$/i.test(path);
}

beforeEach(() => {
  hoisted.electronApp.isPackaged = false;
  hoisted.fileExists.mockReset().mockResolvedValue(true);
  hoisted.isMusicFile.mockReset().mockImplementation(looksLikeMusicFile);
});

afterEach(() => {
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
    expect(parseMoveRun("--moverun", 0, ["--moverun", "src", "dest"])).toEqual([
      "src",
      "dest",
    ]);
  });

  it("ignores a --moverun without both operands", () => {
    expect(parseMoveRun("--moverun", 0, ["--moverun", "src"])).toBeNull();
    expect(parseMoveRun("--moverun", 0, ["--moverun"])).toBeNull();
  });

  it("ignores other arguments", () => {
    expect(
      parseMoveRun("orpheus://x", 0, ["orpheus://x", "src", "dest"])
    ).toBeNull();
    expect(parseMoveRun("src", 1, ["--moverun", "src", "dest"])).toBeNull();
  });
});

describe("parseLocalFile", () => {
  it("returns the normalised path of an existing music file", async () => {
    await expect(parseLocalFile("song.mp3")).resolves.toBe("song.mp3");
    await expect(parseLocalFile("music/album/song.mp3")).resolves.toBe(
      normalize("music/album/song.mp3")
    );

    expect(hoisted.fileExists).toHaveBeenCalledWith(
      normalize("music/album/song.mp3")
    );
  });

  it("normalises the path before checking it", async () => {
    await parseLocalFile("music/./album/../song.mp3");

    expect(hoisted.fileExists).toHaveBeenCalledWith(
      normalize("music/song.mp3")
    );
  });

  it("rejects paths that are not music files", async () => {
    await expect(parseLocalFile("cover.jpg")).resolves.toBeNull();
    await expect(parseLocalFile("no-extension")).resolves.toBeNull();

    expect(hoisted.fileExists).not.toHaveBeenCalled();
  });

  it("rejects music files that do not exist on disk", async () => {
    hoisted.fileExists.mockResolvedValue(false);

    await expect(parseLocalFile("missing.mp3")).resolves.toBeNull();
  });

  it("rejects an empty argument", async () => {
    await expect(parseLocalFile("")).resolves.toBeNull();

    // "." is not a music file, so the disk is never touched.
    expect(hoisted.isMusicFile).toHaveBeenCalledWith(".");
    expect(hoisted.fileExists).not.toHaveBeenCalled();
  });

  it("checks every argument on its own", async () => {
    // Only a single path is considered: joining the surrounding argv into one
    // path is no longer attempted, so exactly one path ever reaches the disk.
    await expect(parseLocalFile("music")).resolves.toBeNull();
    await expect(parseLocalFile("my album")).resolves.toBeNull();
    await expect(parseLocalFile("song.mp3")).resolves.toBe("song.mp3");

    expect(hoisted.fileExists).toHaveBeenCalledExactlyOnceWith("song.mp3");
  });
});

describe.runIf(process.platform === "win32")(
  "parseLocalFile on Windows",
  () => {
    it("converts forward slashes to backslashes", async () => {
      await expect(parseLocalFile("music/album/song.mp3")).resolves.toBe(
        "music\\album\\song.mp3"
      );

      expect(hoisted.fileExists).toHaveBeenCalledWith("music\\album\\song.mp3");
    });
  }
);

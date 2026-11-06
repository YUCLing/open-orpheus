import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  root: "test-results/addid3-test",
  registerCallHandler: vi.fn(),
  load: vi.fn(),
  sendIfAlive: vi.fn(),
  cp: vi.fn(),
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    cp: (...args: Parameters<typeof actual.cp>) => hoisted.cp(...args),
  };
});

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => hoisted.root) },
  dialog: { showErrorBox: vi.fn() },
  Notification: class {
    show() {}
  },
}));

vi.mock("music-tag-native", () => ({
  MusicFile: { load: hoisted.load },
  MetaPicture: class {
    constructor() {}
  },
}));

vi.mock("../../../src/main/calls", () => ({
  registerCallHandler: hoisted.registerCallHandler,
}));

vi.mock("../../../src/main/folders", () => ({
  data: `${hoisted.root}/data`,
  defaultCache: `${hoisted.root}/cache`,
  download: `${hoisted.root}/download`,
  downloadTemp: `${hoisted.root}/temp`,
  setCachePath: vi.fn(),
  setDownloadPath: vi.fn(),
}));

vi.mock("../../../src/main/database", () => ({
  webDb: { executeSql: vi.fn() },
}));

vi.mock("../../../src/main/cache/PlayCacheManager", () => ({
  CacheTrackMeta: class {},
}));

vi.mock("../../../src/main/cache", () => ({
  default: vi.fn(),
  createCacheManager: vi.fn(),
  lyricCacheManager: { set: vi.fn() },
  playCacheManager: { setConfig: vi.fn() },
}));

vi.mock("../../../src/main/logger", () => ({ default: hoisted.logger }));

vi.mock("../../../src/main/util/send", () => ({
  sendIfAlive: hoisted.sendIfAlive,
}));

vi.mock("../../../src/main/util/fs", () => ({
  fileExists: vi.fn(),
  isFileNotFound: vi.fn(),
  isWritableDir: vi.fn(),
  move: vi.fn(),
}));

vi.mock("../../../src/main/util/musicFile", () => ({
  isMusicFile: vi.fn(() => true),
}));

vi.mock("../../../src/main/id3", () => ({
  commentToID3Json: vi.fn(),
  ID3JsonToComment: vi.fn((value: unknown) => JSON.stringify(value)),
}));

vi.mock("@shared/util", () => ({
  toError: (error: unknown) => error,
}));

type AddId3Handler = (
  event: unknown,
  taskId: string,
  mediaPath: string,
  imagePath: string,
  mediaInfo: string,
  id3Info: Record<string, unknown>
) => Promise<void>;

const mediaPath = path.join(hoisted.root, "temp", "song.mp3");
const finalPath = path.join(hoisted.root, "download", "song.mp3");

const id3Info = {
  media_rel_path: "song.mp3",
  talb: "Album",
  tit2: "Title",
  tpe1: "Artist",
  tpos: "1",
  trck: "2",
};

let addId3: AddId3Handler;
let actualCp: typeof import("node:fs/promises").cp;
let completed: Promise<void>;
let markCompleted: () => void;

beforeAll(async () => {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  actualCp = fs.cp;

  await import("../../../src/main/calls/storage");

  const registration = hoisted.registerCallHandler.mock.calls.find(
    ([command]) => command === "storage.addid3"
  );
  expect(registration).toBeDefined();
  addId3 = registration![1] as AddId3Handler;
});

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.load.mockReset();
  hoisted.sendIfAlive.mockReset();
  hoisted.cp.mockReset();
  hoisted.cp.mockImplementation((...args: Parameters<typeof actualCp>) => actualCp(...args));

  completed = new Promise<void>((resolve) => {
    markCompleted = resolve;
  });
  hoisted.sendIfAlive.mockImplementation(() => {
    markCompleted();
  });

  await rm(hoisted.root, { recursive: true, force: true });
  await mkdir(path.dirname(mediaPath), { recursive: true });
  await writeFile(mediaPath, "original");
});

afterEach(async () => {
  await rm(hoisted.root, { recursive: true, force: true });
});

async function invoke() {
  void addId3({ sender: {} } as never, "task-1", mediaPath, "", "", id3Info);
  await completed;
}

describe("storage.addid3 fallback", () => {
  it("copies the media file when MusicFile.load fails", async () => {
    hoisted.load.mockRejectedValue(new Error("invalid audio"));

    await invoke();

    await expect(readFile(finalPath, "utf-8")).resolves.toBe("original");
    await expect(stat(mediaPath)).rejects.toThrow();
    expect(hoisted.sendIfAlive).toHaveBeenLastCalledWith(
      expect.anything(),
      "channel.call",
      "storage.onaddid3done",
      "task-1",
      1,
      "song.mp3"
    );
  });

  it("replaces a partially written destination when save throws", async () => {
    hoisted.load.mockResolvedValue({
      save: async (destination: string) => {
        await writeFile(destination, "partial");
        throw new Error("save failed");
      },
    });

    await invoke();

    await expect(readFile(finalPath, "utf-8")).resolves.toBe("original");
    await expect(stat(mediaPath)).rejects.toThrow();
    expect(hoisted.cp).toHaveBeenCalledTimes(1);
    expect(hoisted.sendIfAlive).toHaveBeenLastCalledWith(
      expect.anything(),
      "channel.call",
      "storage.onaddid3done",
      "task-1",
      1,
      "song.mp3"
    );
  });

  it("reports failure and keeps the source when the fallback copy fails", async () => {
    hoisted.load.mockRejectedValue(new Error("invalid audio"));
    hoisted.cp.mockRejectedValue(new Error("copy failed"));

    await invoke();

    await expect(stat(finalPath)).rejects.toThrow();
    await expect(readFile(mediaPath, "utf-8")).resolves.toBe("original");
    expect(hoisted.sendIfAlive).toHaveBeenLastCalledWith(
      expect.anything(),
      "channel.call",
      "storage.onaddid3done",
      "task-1",
      0
    );
  });

  it("writes tagged files normally and removes the source", async () => {
    hoisted.load.mockResolvedValue({
      save: async (destination: string) => {
        await writeFile(destination, "tagged");
      },
    });

    await invoke();

    await expect(readFile(finalPath, "utf-8")).resolves.toBe("tagged");
    await expect(stat(mediaPath)).rejects.toThrow();
    expect(hoisted.cp).not.toHaveBeenCalled();
    expect(hoisted.sendIfAlive).toHaveBeenLastCalledWith(
      expect.anything(),
      "channel.call",
      "storage.onaddid3done",
      "task-1",
      1,
      "song.mp3"
    );
  });
});

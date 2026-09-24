import { normalize } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type CallDispatcher from "../../../src/CallDispatcher";

import { installLoggerStub } from "../../helpers/globals";

// `calls/app.ts` registers a lot of unrelated handlers, so every module it
// touches at import time is stubbed out here. The two handlers under test only
// need `../arguments`, `../lifecycle` and `../util`, which stay real unless a
// test says otherwise.
const hoisted = vi.hoisted(() => ({
  fileExists: vi.fn<(path: string) => Promise<boolean>>(),
  isMusicFile: vi.fn((path: string) => path.length > 0),
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
  kv: { get: vi.fn(), set: vi.fn() },
  setStartupTask: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/open-orpheus-test/${name}`),
    quit: vi.fn(),
    setThumbarButtons: vi.fn(),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: {
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  nativeImage: { createFromBuffer: vi.fn() },
}));

vi.mock("../../../src/main/logger", () => ({ default: hoisted.logger }));
vi.mock("../../../src/main/settings", () => ({ kv: hoisted.kv }));
vi.mock("../../../src/main/pack", () => ({
  default: { loadSkinPack: vi.fn(), webPack: null },
  NO_WEBPACK_ERROR_MESSAGE: "No usable web pack file found",
}));
vi.mock("../../../src/main/orpheus", () => ({
  loadFromOrpheusUrl: vi.fn(),
  default: vi.fn(),
}));
vi.mock("../../../src/main/request", () => ({
  client: {},
  getProxyAgent: vi.fn(),
}));
vi.mock("../../../src/main/dawn", () => ({
  statisV2: vi.fn(),
  setStatisEndpoint: vi.fn(),
}));
vi.mock("../../../src/main/folders", () => ({
  disableHardwareAccelerationFlag: "/tmp/open-orpheus-test/flag",
}));
vi.mock("../../../src/main/util", () => ({
  fileExists: hoisted.fileExists,
  isMusicFile: hoisted.isMusicFile,
  pngFromIco: vi.fn(),
}));

installLoggerStub();

/** Import a private copy of the modules so each test starts from a clean slate. */
async function freshModules() {
  vi.resetModules();

  const [{ dispatcher }, lifecycle] = await Promise.all([
    import("../../../src/main/calls"),
    import("../../../src/main/lifecycle"),
    // Registers the `app.*` handlers on the fresh dispatcher.
    import("../../../src/main/calls/app"),
  ]);

  return { dispatcher, lifecycle };
}

/** Dispatch a command and return the tuple spread onto the callback. */
async function call(
  dispatcher: CallDispatcher,
  command: string,
  ...args: unknown[]
) {
  const callback = vi.fn();
  await dispatcher.dispatch(command, callback, { sender: "test" }, ...args);
  return callback.mock.calls[0] as unknown[];
}

function stubProcessArgv(argv: string[]) {
  vi.stubGlobal("process", { ...process, argv });
}

/** Stand-in for the real mime lookup used by `isMusicFile`. */
function looksLikeMusicFile(path: string) {
  return /\.(mp3|flac|wav|m4a|ogg|opus|aac)$/i.test(path);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  hoisted.fileExists.mockReset().mockResolvedValue(true);
  hoisted.isMusicFile.mockReset().mockImplementation(looksLikeMusicFile);
});

describe("app.getAppStartCommand", () => {
  it("plays the local file that was opened while starting up", async () => {
    const { dispatcher, lifecycle } = await freshModules();
    lifecycle.setStartupTask({ type: "openFile", file: "song.mp3" });

    const [command] = await call(dispatcher!, "app.getAppStartCommand");

    expect(command).toEqual({ play: "song.mp3" });
  });

  it("forwards the URL that was opened while starting up", async () => {
    const { dispatcher, lifecycle } = await freshModules();
    lifecycle.setStartupTask({ type: "openUrl", url: "orpheus://song/1" });

    const [command] = await call(dispatcher!, "app.getAppStartCommand");

    expect(command).toEqual({ webcmd: "orpheus://song/1" });
  });

  it("reports nothing when there is no argument to act on", async () => {
    const { dispatcher } = await freshModules();
    stubProcessArgv(["electron", "."]);

    const [command] = await call(dispatcher!, "app.getAppStartCommand");

    // An empty array is spread onto the callback, so the payload is absent.
    expect(command).toBeUndefined();
  });

  it("parses a --moverun command", async () => {
    const { dispatcher } = await freshModules();
    stubProcessArgv([
      "electron",
      ".",
      "--moverun",
      "/music/old.mp3",
      "/music/new.mp3",
    ]);

    const [command] = await call(dispatcher!, "app.getAppStartCommand");

    expect(command).toEqual({
      movesrc: "/music/old.mp3",
      movedest: "/music/new.mp3",
    });
  });

  it("parses an orpheus URL", async () => {
    const { dispatcher } = await freshModules();
    stubProcessArgv(["electron", ".", "orpheus://song/1"]);

    const [command] = await call(dispatcher!, "app.getAppStartCommand");

    expect(command).toEqual({ webcmd: "orpheus://song/1" });
  });

  it("parses a local file argument", async () => {
    const { dispatcher } = await freshModules();
    stubProcessArgv(["electron", ".", "some/song.mp3"]);

    const [command] = await call(dispatcher!, "app.getAppStartCommand");

    expect(command).toEqual({ play: normalize("some/song.mp3") });
  });

  it("prefers an orpheus URL over a local file in the same argv", async () => {
    const { dispatcher } = await freshModules();
    stubProcessArgv(["electron", ".", "some/song.mp3", "orpheus://song/1"]);

    const [command] = await call(dispatcher!, "app.getAppStartCommand");

    // `raceArgument` settles with the first predicate that finishes, not the
    // first argv entry. The URL matches synchronously, while the local file has
    // to await a disk lookup, so the URL wins even though it comes second.
    expect(command).toEqual({ webcmd: "orpheus://song/1" });
  });

  it("prefers --moverun over a local file in the same argv", async () => {
    const { dispatcher } = await freshModules();
    stubProcessArgv([
      "electron",
      ".",
      "--moverun",
      "/music/old.mp3",
      "/music/new.mp3",
    ]);
    // Music files are not filtered out here; the ordering inside the predicate
    // is what decides.
    hoisted.isMusicFile.mockReturnValue(true);

    const [command] = await call(dispatcher!, "app.getAppStartCommand");

    expect(command).toEqual({
      movesrc: "/music/old.mp3",
      movedest: "/music/new.mp3",
    });
  });
});

describe("app.getDefaultMusicPlayPath", () => {
  it("returns the file opened while starting up", async () => {
    const { dispatcher, lifecycle } = await freshModules();
    lifecycle.setStartupTask({ type: "openFile", file: "song.mp3" });

    const [path] = await call(dispatcher!, "app.getDefaultMusicPlayPath");

    expect(path).toBe("song.mp3");
  });

  it("returns nothing when the startup task is not a local file", async () => {
    const { dispatcher, lifecycle } = await freshModules();
    lifecycle.setStartupTask({ type: "openUrl", url: "orpheus://song/1" });
    stubProcessArgv(["electron", ".", "some/song.mp3"]);

    const [path] = await call(dispatcher!, "app.getDefaultMusicPlayPath");

    expect(path).toBe(normalize("some/song.mp3"));
  });

  it("falls back to a music file in the process argv", async () => {
    const { dispatcher } = await freshModules();
    stubProcessArgv(["electron", ".", "some/song.mp3"]);

    const [path] = await call(dispatcher!, "app.getDefaultMusicPlayPath");

    expect(hoisted.isMusicFile).toHaveBeenCalledWith(
      normalize("some/song.mp3")
    );
    expect(path).toBe(normalize("some/song.mp3"));
  });

  it("returns nothing when no argument is a local file", async () => {
    const { dispatcher } = await freshModules();
    stubProcessArgv(["electron", ".", "--some-flag"]);
    hoisted.isMusicFile.mockReturnValue(false);

    const [path] = await call(dispatcher!, "app.getDefaultMusicPlayPath");

    expect(path).toBeUndefined();
  });
});

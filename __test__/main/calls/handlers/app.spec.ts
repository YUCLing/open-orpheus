import { normalize } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type CallDispatcher from "@shared/CallDispatcher";

import { installLoggerStub } from "../../../helpers/globals";

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
    // The merged import graph reaches windows/managedWindow.ts, which registers
    // a `browser-window-created` listener at module scope.
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: {
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  nativeImage: { createFromBuffer: vi.fn() },
}));

vi.mock("@main/platform/logger", () => ({ default: hoisted.logger }));
vi.mock("@main/services/settings", () => ({ kv: hoisted.kv }));
vi.mock("@main/services/pack", () => ({
  // `windows/mini-player.ts` subscribes to the pack manager at module scope,
  // and the merged graph reaches it from here.
  default: { loadSkinPack: vi.fn(), webPack: null, on: vi.fn() },
  NO_WEBPACK_ERROR_MESSAGE: "No usable web pack file found",
}));
vi.mock("@main/platform/orpheus", () => ({
  loadFromOrpheusUrl: vi.fn(),
  default: vi.fn(),
}));
vi.mock("@main/platform/request", () => ({
  client: {},
  getProxyAgent: vi.fn(),
}));
vi.mock("@main/platform/dawn", () => ({
  statisV2: vi.fn(),
  setStatisEndpoint: vi.fn(),
}));
// Partially mocked: the merged import graph reaches more of this module than
// it used to (domain/xeapi.ts wants `data` and `aegisPublicKey`), so only the
// value this spec cares about is overridden.
vi.mock("@main/platform/folders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@main/platform/folders")>()),
  disableHardwareAccelerationFlag: "/tmp/open-orpheus-test/flag",
}));
vi.mock("@main/platform/util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@main/platform/util")>()),
  fileExists: hoisted.fileExists,
  isMusicFile: hoisted.isMusicFile,
  pngFromIco: vi.fn(),
}));

installLoggerStub();

/** Import a private copy of the modules so each test starts from a clean slate. */
async function freshModules() {
  vi.resetModules();

  const { dispatcher } = await import("@main/calls/dispatcher");
  const lifecycle = await import("@main/services/lifecycle");

  // Registration is explicit in the refactor (P1-11): importing the handler
  // module no longer registers anything as a side effect, so the `app.*`
  // handlers are registered here, on the freshly reset dispatcher.
  const { register } = await import("@main/calls/handlers/app");
  register({
    settings: { kv: hoisted.kv } as never,
    lifecycle: { setLifecycleState: lifecycle.setLifecycleState },
  });

  return { dispatcher, lifecycle };
}

/** Dispatch a command and return the tuple spread onto the callback. */
async function call(dispatcher: CallDispatcher, command: string, ...args: unknown[]) {
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
    stubProcessArgv(["electron", ".", "--moverun", "/music/old.mp3", "/music/new.mp3"]);

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
    stubProcessArgv(["electron", ".", "--moverun", "/music/old.mp3", "/music/new.mp3"]);
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

    expect(hoisted.isMusicFile).toHaveBeenCalledWith(normalize("some/song.mp3"));
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

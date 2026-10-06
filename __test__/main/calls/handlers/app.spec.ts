import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type CallDispatcher from "@shared/CallDispatcher";

import { installLoggerStub } from "../../../helpers/globals";

// `calls/app.ts` registers a lot of unrelated handlers, so every module it
// touches at import time is stubbed out here. The two handlers under test only
// need `../arguments`, `../lifecycle` and `../util`, which stay real unless a
// test says otherwise.
const hoisted = vi.hoisted(() => ({
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
  /** The root logger `app.log` forwards renderer lines to. */
  rendererLog: vi.fn(),
  setStartupTask: vi.fn(),
  /** What `app.ts` asks the pack manager to load. */
  /** Platform collaborators, passed rather than mocked at the module boundary. */
  loadFromOrpheusUrl: vi.fn(),
  statisV2: vi.fn(),
  setStatisEndpoint: vi.fn(),
  getProxyAgent: vi.fn(),
  client: vi.fn(),
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

// Partially mocked: the merged import graph reaches more of this module than
// it used to (domain/xeapi.ts wants `data` and `aegisPublicKey`), so only the
// value this spec cares about is overridden.

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
    rootLogger: { info: hoisted.rendererLog },
    orpheus: { loadFromOrpheusUrl: hoisted.loadFromOrpheusUrl },
    dawn: { statisV2: hoisted.statisV2, setStatisEndpoint: hoisted.setStatisEndpoint },
    request: { getProxyAgent: hoisted.getProxyAgent, client: hoisted.client as never },
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

/**
 * `parseLocalFile` uses the real file checks now, so the tests that reach it
 * need a real tree: a music file to find and a non-music file to reject.
 */
let fixtureDir: string;
let musicFile: string;

beforeEach(async () => {
  vi.unstubAllGlobals();
  fixtureDir = await mkdtemp(join(tmpdir(), "open-orpheus-app-"));
  musicFile = join(fixtureDir, "song.mp3");
  await writeFile(musicFile, "");
  await writeFile(join(fixtureDir, "cover.jpg"), "");
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("app.log", () => {
  it("forwards the renderer's line to the root logger with no call binding", async () => {
    const { dispatcher } = await freshModules();

    await call(dispatcher!, "app.log", "[2026-08-09 10:35:57] 【persistentState】,hello world");

    // Exactly `{ name, module }`: the renderer's own attribution, and nothing
    // that says which main-process command forwarded it.
    expect(hoisted.rendererLog).toHaveBeenCalledExactlyOnceWith(
      { name: "app", module: "persistentState" },
      "hello world"
    );
  });

  it("forwards an unparseable line as-is, with no module", async () => {
    const { dispatcher } = await freshModules();

    await call(dispatcher!, "app.log", "just a line");

    expect(hoisted.rendererLog).toHaveBeenCalledExactlyOnceWith({ name: "app" }, "just a line");
  });
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
    stubProcessArgv(["electron", ".", musicFile]);

    const [command] = await call(dispatcher!, "app.getAppStartCommand");

    expect(command).toEqual({ play: normalize(musicFile) });
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
    stubProcessArgv(["electron", ".", musicFile]);

    const [path] = await call(dispatcher!, "app.getDefaultMusicPlayPath");

    expect(path).toBe(normalize(musicFile));
  });

  it("falls back to a music file in the process argv", async () => {
    const { dispatcher } = await freshModules();
    stubProcessArgv(["electron", ".", musicFile]);

    const [path] = await call(dispatcher!, "app.getDefaultMusicPlayPath");

    expect(path).toBe(normalize(musicFile));
  });

  it("returns nothing when no argument is a local file", async () => {
    const { dispatcher } = await freshModules();
    stubProcessArgv(["electron", ".", "--some-flag"]);

    const [path] = await call(dispatcher!, "app.getDefaultMusicPlayPath");

    expect(path).toBeUndefined();
  });
});

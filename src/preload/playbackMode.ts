import { contextBridge, ipcRenderer } from "electron";

import { isPlaybackMode } from "@shared/playbackMode";
import type { PlaybackMode } from "@shared/types/playback-mode";
import { toError } from "@shared/util";

import { channel } from "./util";

let command: ((mode: PlaybackMode) => Promise<void>) | undefined;

const bridgeApi = {
  // Validate the page's raw mode in the main process.
  reportMode: (mode: string) => ipcRenderer.send("player.playbackmodechange", mode),
  onCommand: (handler: (mode: PlaybackMode) => Promise<void>) => {
    command = handler;
  },
};

export type PlaybackModeBridgeApi = typeof bridgeApi;

interface PlayingStore {
  getState(): { playing?: { playingMode?: unknown } };
  dispatch(action: { type: string; payload: { playingMode: PlaybackMode } }): unknown;
  subscribe(listener: () => void): () => void;
}

interface FiberNode {
  child: FiberNode | null;
  sibling: FiberNode | null;
  memoizedProps: unknown;
  stateNode?: { current?: FiberNode };
}

/**
 * Runs in the page's main world: keep runtime dependencies inside this function.
 * Read the mounted React tree to find the Provider store or dva route's app.
 * All playback changes go through the page's own playing model.
 */
export function installPlaybackModeBridge(api: PlaybackModeBridgeApi): void {
  const FIBER_BUDGET = 50_000;
  const DISCOVERY_TIMEOUT_MS = 30_000;
  const DISCOVERY_INTERVAL_MS = 250;
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  let store: PlayingStore | undefined;
  let previous: unknown;

  const playingStore = (value: unknown): PlayingStore | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Partial<PlayingStore>;
    if (
      typeof candidate.getState !== "function" ||
      typeof candidate.dispatch !== "function" ||
      typeof candidate.subscribe !== "function"
    ) {
      return undefined;
    }
    try {
      return typeof candidate.getState().playing?.playingMode === "string"
        ? (value as PlayingStore)
        : undefined;
    } catch {
      return undefined;
    }
  };

  const rootFiberOf = (node: unknown): FiberNode | undefined => {
    if (!node || typeof node !== "object") return undefined;
    const container = node as {
      _reactRootContainer?: { _internalRoot?: { current?: FiberNode | null } };
    };
    const legacy = container._reactRootContainer?._internalRoot?.current;
    if (legacy) return legacy;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key.startsWith("__reactContainer$")) {
        const root = record[key] as FiberNode | undefined;
        return root?.stateNode?.current ?? root;
      }
    }
    return undefined;
  };

  const findStore = (): PlayingStore | undefined => {
    const root = rootFiberOf(document.querySelector("#root") ?? document.body);
    if (!root) return undefined;
    const stack: FiberNode[] = [root];
    let budget = FIBER_BUDGET;
    while (stack.length > 0 && budget > 0) {
      budget -= 1;
      const fiber = stack.pop();
      if (!fiber) break;
      const props = fiber.memoizedProps;
      if (props && typeof props === "object") {
        const record = props as Record<string, unknown>;
        const app = record.app as { _store?: unknown } | undefined;
        const found = playingStore(record.store) ?? playingStore(app?._store);
        if (found) return found;
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return undefined;
  };

  const report = (): void => {
    if (!store) return;
    try {
      const mode = store.getState().playing?.playingMode;
      if (typeof mode !== "string" || mode === previous) return;
      api.reportMode(mode);
      previous = mode;
    } catch (err) {
      // Subscribers run inside the page's dispatch; keep its actions running.
      console.warn("Open Orpheus: failed to report the playback mode", err);
    }
  };

  const connect = (candidate: PlayingStore): void => {
    try {
      candidate.subscribe(report);
      api.onCommand(async (mode) => {
        await candidate.dispatch({
          type: "playing/switchPlayingMode",
          payload: { playingMode: mode },
        });
      });
    } catch (err) {
      console.warn("Open Orpheus: failed to connect to the playing store", err);
      return;
    }
    store = candidate;
    report();
  };

  // Retry until the page mounts. The connected subscription lives with the
  // document, including a back/forward-cache restore.
  const discover = (): void => {
    try {
      const found = findStore();
      if (found) {
        connect(found);
        return;
      }
    } catch {
      // The tree may still be mounting; try again on the next timeout.
    }
    if (Date.now() < deadline) {
      setTimeout(discover, DISCOVERY_INTERVAL_MS);
    } else {
      console.warn("Open Orpheus: renderer playback-mode integration is unavailable");
    }
  };

  discover();
}

if (channel === "main") {
  ipcRenderer.on("player.playbackmode", (_event, mode: unknown) => {
    if (!isPlaybackMode(mode)) return;
    if (!command) {
      LOGGER.warn("Renderer playback-mode integration is not ready");
      return;
    }
    void command(mode).catch((err) => {
      LOGGER.warn({ err: toError(err) }, "Renderer rejected playback-mode change");
    });
  });
  contextBridge.executeInMainWorld({
    func: installPlaybackModeBridge,
    args: [bridgeApi],
  });
}

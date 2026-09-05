/**
 * AV3A decode service — Electron utility process entrypoint.
 *
 * This process owns the native decoder AND the decode pacing session
 * (`Av3aM4aSession`), so neither depends on the main process staying
 * responsive. The main process only starts it (with the temp-file path) and
 * answers `ensureRange` requests (the file is downloaded by main). Everything
 * else — `opened`/`pcm`/`done`/`error` events and pause/resume/seek — travels
 * on a `MessageChannelMain` port whose far end lives in the renderer, so those
 * messages never transit main.
 *
 * Decode pacing: the session only asks main for bytes when the next frame
 * needs data beyond the last-known contiguous download frontier (which main
 * refreshes with periodic `frontier` messages). While main is busy (e.g. a
 * Windows modal drag loop blocking it), this process keeps decoding the
 * already-buffered file straight into the renderer.
 *
 * Messaging:
 *   main -> here (`process.parentPort`):
 *                 { type: "init", path, totalLength, prefixEnd } (+ renderer port)
 *                 { type: "frontier", prefixEnd }
 *                 { type: "rangeReady" | "rangeError", id, ... }
 *   here -> main: { type: "ensureRange", id, start, end }
 *   renderer -> here (renderer port): { type: "pause" | "resume" | "seek", frameIndex? }
 *   here -> renderer (renderer port): { type: "opened" } | { type: "pcm", ... } |
 *                                     { type: "done" } | { type: "error", ... }
 */
import type { MessagePortMain } from "electron";
import { Av3AM4ADecoder } from "@open-orpheus/av3a";

import type {
  Av3aChannelRendererToService as RendererToService,
  Av3aChannelServiceToRenderer as ServiceToRenderer,
  Av3aProcessMainToService as MainToService,
  Av3aProcessServiceToMain as ServiceToMain,
} from "../bridge/contracts/av3a-process";
import { Av3aM4aSession } from "../main/av3a/Av3aM4aSession";
import type { Av3aM4aSource } from "../main/av3a/Av3aM4aSession";
import type {
  Av3aDecodedFrame,
  Av3aDecodeExecutor,
  Av3aSampleRange,
  Av3aTrackInfo,
} from "../main/av3a/types";

const parent = process.parentPort;
if (!parent) {
  throw new Error(
    "av3a decode service must run inside an Electron utility process"
  );
}

/** Contiguous downloaded prefix (bytes) known without asking main. */
let cachedFrontier = 0;
let rendererPort: MessagePortMain | null = null;
let session: Av3aM4aSession | null = null;
let started = false;

// #region native decoder executor

/**
 * Yield to the event loop so messages on other ports (pause/resume/seek,
 * frontier/rangeReady) get processed between synchronous native decode calls.
 * Without this, a decode burst would run as one long microtask chain and never
 * service the ports.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Direct calls into the native decoder. */
class NativeAv3aExecutor implements Av3aDecodeExecutor {
  private decoder: Av3AM4ADecoder | null = null;

  private requireDecoder(): Av3AM4ADecoder {
    if (!this.decoder) throw new Error("av3a decoder is not open");
    return this.decoder;
  }

  async open(path: string): Promise<void> {
    await yieldToEventLoop();
    if (this.decoder) {
      this.decoder.close();
      this.decoder = null;
    }
    this.decoder = new Av3AM4ADecoder(path);
  }

  async info(): Promise<Av3aTrackInfo> {
    await yieldToEventLoop();
    return this.requireDecoder().info() as Av3aTrackInfo;
  }

  async seekToFrame(frameIndex: number): Promise<void> {
    await yieldToEventLoop();
    this.requireDecoder().seekToFrame(frameIndex);
  }

  async nextSampleRange(): Promise<Av3aSampleRange> {
    await yieldToEventLoop();
    return this.requireDecoder().nextSampleRange() as Av3aSampleRange;
  }

  async decodeWindowRange(): Promise<Av3aSampleRange> {
    await yieldToEventLoop();
    return this.requireDecoder().decodeWindowRange() as Av3aSampleRange;
  }

  async decodeNext(): Promise<Av3aDecodedFrame> {
    await yieldToEventLoop();
    return this.requireDecoder().decodeNext() as Av3aDecodedFrame;
  }

  async close(): Promise<void> {
    await yieldToEventLoop();
    this.decoder?.close();
    this.decoder = null;
  }
}

// #endregion

// #region data source backed by main (frontier-cached)

type PendingRange = {
  resolve: () => void;
  reject: (error: Error) => void;
  end: number;
};

const pendingRanges = new Map<number, PendingRange>();
let rangeSeq = 0;

function requestRange(start: number, end: number, signal?: AbortSignal) {
  const id = ++rangeSeq;
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      pendingRanges.delete(id);
      reject(new Error("av3a range request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pendingRanges.set(id, {
      resolve: () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      reject: (error: Error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
      end,
    });
    parent.postMessage({
      type: "ensureRange",
      id,
      start,
      end,
    } satisfies ServiceToMain);
  });
}

/** `Av3aM4aSource` whose frontier lives here, refreshed by main's pushes. */
function makeIpcSource(path: string, totalLength: number): Av3aM4aSource {
  return {
    path,
    totalLength,
    prefixEnd: () => cachedFrontier,
    ensureRange: (start, end, signal) => requestRange(start, end, signal),
  };
}

// #endregion

function handleRendererMessage(msg: RendererToService): void {
  if (!session) return;
  switch (msg.type) {
    case "pause":
      session.pause();
      break;
    case "resume":
      session.resume();
      break;
    case "seek":
      if (session.isRunning) {
        session.seekToFrame(msg.frameIndex);
      } else {
        // Decode already finished (EOF); a seek must restart it from the new
        // position so the target section produces PCM again.
        void session.runFrom(msg.frameIndex).catch(() => {});
      }
      break;
  }
}

function attachRendererPort(port: MessagePortMain): void {
  rendererPort = port;
  port.on("message", (e: { data: RendererToService }) => {
    handleRendererMessage(e.data);
  });
  port.start();
}

async function startService(
  msg: MainToService & { type: "init" }
): Promise<void> {
  if (started) return;
  started = true;

  cachedFrontier = msg.prefixEnd;
  const executor = new NativeAv3aExecutor();
  const source = makeIpcSource(msg.path, msg.totalLength);

  session = new Av3aM4aSession(executor, source, {
    onOpened: (info) => {
      rendererPort?.postMessage({ type: "opened", info });
    },
    onPcm: (frame) => {
      if (!rendererPort) return;
      if (frame.done || !frame.data) return;
      const out: ServiceToRenderer = {
        type: "pcm",
        frameIndex: frame.frameIndex,
        sampleRate: frame.sampleRate,
        channels: frame.channels,
        pts: frame.pts,
        data: frame.data,
      };
      rendererPort.postMessage(out);
    },
    onDone: () => {
      rendererPort?.postMessage({ type: "done" });
    },
    onError: (error) => {
      rendererPort?.postMessage({ type: "error", message: error.message });
    },
  });

  // Runs until done/error; this process is torn down by main (kill) on stop.
  void session.run();
}

function handleMainMessage(msg: MainToService): void {
  switch (msg.type) {
    case "frontier":
      cachedFrontier = Math.max(cachedFrontier, msg.prefixEnd);
      resolveCoveredRanges();
      break;
    case "rangeReady":
      cachedFrontier = Math.max(cachedFrontier, msg.prefixEnd);
      resolveRange(msg.id);
      resolveCoveredRanges();
      break;
    case "rangeError":
      rejectRange(msg.id, new Error(msg.message));
      break;
    default:
      break;
  }
}

/** Resolve every pending range that the (now known) frontier fully covers. */
function resolveCoveredRanges(): void {
  for (const [id, pending] of pendingRanges) {
    if (pending.end <= cachedFrontier) {
      pendingRanges.delete(id);
      pending.resolve();
    }
  }
}

function resolveRange(id: number): void {
  const pending = pendingRanges.get(id);
  if (!pending) return;
  pendingRanges.delete(id);
  pending.resolve();
}

function rejectRange(id: number, error: Error): void {
  const pending = pendingRanges.get(id);
  if (!pending) return;
  pendingRanges.delete(id);
  pending.reject(error);
}

parent.on("message", (e: { data: MainToService; ports: MessagePortMain[] }) => {
  const { data, ports } = e;
  if (data && data.type === "init") {
    attachRendererPort(ports[0]);
    void startService(data as MainToService & { type: "init" });
    return;
  }
  handleMainMessage(data);
});

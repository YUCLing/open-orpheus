import { app, MessageChannelMain, utilityProcess } from "electron";
import type { MessagePortMain, UtilityProcess, WebContents } from "electron";
import { fileURLToPath } from "node:url";

// eslint-disable-next-line import/default
import decoderProcessPath from "../../workers/av3a-decoder?worker&url";

import type {
  Av3aProcessMainToService,
  Av3aProcessServiceToMain,
} from "../../bridge/contracts/av3a-process";
import type { Av3aM4aSource } from "./Av3aM4aSession";
import { toError } from "../../util";

/**
 * Main-process side of the AV3A decode utility process.
 *
 * Owns the child process lifecycle and the `MessageChannelMain` whose renderer
 * end is handed to the player window (`av3a.channel`). PCM and renderer flow
 * control (pause/resume/seek) travel on that channel directly between the
 * renderer and the utility process — never through main — so playback keeps
 * flowing while main is blocked (e.g. a Windows modal window-drag loop).
 *
 * Main stays on the data path only for what it owns: answering `ensureRange`
 * requests (the file is downloaded here by `OnlineStreamer`) and periodically
 * pushing the contiguous download frontier so the utility can decode ahead
 * without asking. All decode events and PCM go renderer<->utility over the
 * channel; main only pushes a fallback `av3a.error` if the process dies
 * unexpectedly.
 */

export type Av3aPlaybackProcessOptions = {
  /** The sparse temp file + download control (an `OnlineStreamer` adapter). */
  source: Av3aM4aSource;
  /** The window that hosts the player; receives the renderer channel end. */
  rendererWebContents: WebContents;
  /** Push a fallback `av3a.error` to the renderer (decode process crash). */
  sendEvent: (event: string, ...args: unknown[]) => void;
};

const liveProcesses = new Set<Av3aPlaybackProcess>();
let quitHooked = false;

function hookQuitCleanup(): void {
  if (quitHooked) return;
  quitHooked = true;
  app.once("will-quit", () => {
    for (const process of liveProcesses) {
      process.killQuietly();
    }
  });
}

export class Av3aPlaybackProcess {
  private child: UtilityProcess | null = null;
  private rendererPort: MessagePortMain | null = null;
  private frontierTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrontier = -1;
  private stopped = false;

  constructor(private readonly options: Av3aPlaybackProcessOptions) {
    liveProcesses.add(this);
    hookQuitCleanup();
  }

  get alive(): boolean {
    return this.child !== null && this.child.pid !== undefined;
  }

  /**
   * Fork the decode service, wire the renderer channel, and start pushing the
   * download frontier. Resolves once the child has spawned and init is sent.
   */
  async start(): Promise<void> {
    if (this.child) return;

    const { port1, port2 } = new MessageChannelMain();
    // `?worker&url` makes Vite emit the decode service as its own standalone
    // bundle next to the main bundle; fork that emitted file.
    const entryPath = fileURLToPath(
      new URL(decoderProcessPath, import.meta.url)
    );
    const child = utilityProcess.fork(entryPath, [], {
      serviceName: "open-orpheus-av3a",
    });
    this.child = child;
    this.stopped = false;
    this.rendererPort = port1;

    child.on("message", (message: unknown) => {
      this.onChildMessage(message);
    });
    child.on("exit", (code) => {
      this.onChildExit(code);
    });

    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (_type, location) => {
          reject(new Error(`av3a decode process error: ${location}`));
        });
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("av3a decode process spawn timed out"));
        }, 5_000);
      }),
    ]).catch((error: unknown) => {
      this.killQuietly();
      this.child = null;
      liveProcesses.delete(this);
      throw error;
    });

    // A stop() raced the fork; the child is already being torn down.
    if (this.stopped) {
      this.killQuietly();
      this.child = null;
      return;
    }

    // Hand the renderer its end of the channel first, then boot the service
    // with ours + the file to decode.
    this.options.rendererWebContents.postMessage("av3a.channel", null, [port1]);
    const source = this.options.source;
    child.postMessage(
      {
        type: "init",
        path: source.path,
        totalLength: source.totalLength,
        prefixEnd: source.prefixEnd(),
      } satisfies Av3aProcessMainToService,
      [port2]
    );

    this.lastFrontier = source.prefixEnd();
    this.frontierTimer = setInterval(() => {
      this.pushFrontier();
    }, 150);
  }

  /** Stop the child and release the channel. Safe to call twice. */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    this.clearTimer();
    this.closeRendererPort();

    if (child) {
      // The service holds the temp file open; terminate it so the file can be
      // deleted by the caller afterwards.
      child.removeAllListeners("message");
      child.kill();
      await new Promise<void>((resolve) => {
        if (!child) return resolve();
        child.once("exit", () => resolve());
        const timer = setTimeout(() => resolve(), 500);
        child.once("exit", () => clearTimeout(timer));
      }).catch(() => {});
    }
    liveProcesses.delete(this);
  }

  /** Best-effort synchronous kill (used on app quit). */
  killQuietly(): void {
    this.stopped = true;
    this.child?.kill();
    this.clearTimer();
    this.closeRendererPort();
  }

  private pushFrontier(): void {
    const child = this.child;
    if (!child) return;
    const prefixEnd = this.options.source.prefixEnd();
    if (prefixEnd === this.lastFrontier) return;
    this.lastFrontier = prefixEnd;
    child.postMessage({
      type: "frontier",
      prefixEnd,
    } satisfies Av3aProcessMainToService);
  }

  private onChildMessage(message: unknown): void {
    const msg = message as Av3aProcessServiceToMain | null;
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "ensureRange") return;
    const child = this.child;
    if (!child) return;
    const { id, start, end } = msg;
    void this.options.source
      .ensureRange(start, end)
      .then(() => {
        child.postMessage({
          type: "rangeReady",
          id,
          prefixEnd: this.options.source.prefixEnd(),
        } satisfies Av3aProcessMainToService);
      })
      .catch((error: unknown) => {
        child.postMessage({
          type: "rangeError",
          id,
          message: toError(error).message,
        } satisfies Av3aProcessMainToService);
      });
  }

  private onChildExit(code: number): void {
    const unexpected = !this.stopped;
    this.child = null;
    this.clearTimer();
    this.closeRendererPort();
    liveProcesses.delete(this);
    if (unexpected) {
      this.options.sendEvent(
        "error",
        `AV3A decode process exited unexpectedly (code ${code})`
      );
    }
  }

  private clearTimer(): void {
    if (this.frontierTimer !== null) {
      clearInterval(this.frontierTimer);
      this.frontierTimer = null;
    }
  }

  private closeRendererPort(): void {
    if (this.rendererPort) {
      this.rendererPort.removeAllListeners();
      this.rendererPort.close();
      this.rendererPort = null;
    }
  }
}

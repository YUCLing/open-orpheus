import { ipcRenderer } from "electron";

import type {
  Av3aChannelRendererToService,
  Av3aChannelServiceToRenderer,
} from "../../bridge/contracts/av3a-process";
import type { Av3aTrackInfo } from "../../bridge/contracts/av3a-api";

/**
 * Renderer end of the direct channel to the AV3A decode utility process.
 *
 * Each `av3a.start` makes main fork a fresh decode process and hand the player
 * window one end of a `MessageChannelMain` over the `av3a.channel` IPC event
 * (`event.ports[0]`, a real DOM `MessagePort`). The utility process holds the
 * other end. All decode events travel on this port, in order:
 *
 *   utility -> window: opened | pcm | done | error
 *   window -> utility: pause | resume | seek
 *
 * Main is not on this path, so a busy main process can't stall playback.
 * The `av3a` IPC bridge still owns `start`/`stop` and main-origin errors +
 * download progress.
 */

type OpenedHandler = (info: Av3aTrackInfo) => void;
type PcmFrame = Extract<Av3aChannelServiceToRenderer, { type: "pcm" }>;
type DoneHandler = () => void;
type ErrorHandler = (message: string) => void;

let port: MessagePort | null = null;
let openedHandler: OpenedHandler | null = null;
let pcmHandler: ((frame: PcmFrame) => void) | null = null;
let doneHandler: DoneHandler | null = null;
let errorHandler: ErrorHandler | null = null;

function onMessage(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const msg = data as Av3aChannelServiceToRenderer;
  switch (msg.type) {
    case "opened":
      openedHandler?.(msg.info);
      break;
    case "pcm":
      pcmHandler?.(msg);
      break;
    case "done":
      doneHandler?.();
      break;
    case "error":
      errorHandler?.(msg.message);
      break;
  }
}

// A new port arrives for every decode session (each `av3a.start`).
ipcRenderer.on("av3a.channel", (event) => {
  const next = (event.ports[0] as MessagePort | undefined) ?? null;
  if (port && port !== next) {
    port.onmessage = null;
    try {
      port.close();
    } catch {
      // Already closed.
    }
  }
  port = next;
  if (port) {
    port.onmessage = (messageEvent: MessageEvent) => {
      onMessage(messageEvent.data);
    };
  }
});

function send(message: Av3aChannelRendererToService): void {
  port?.postMessage(message);
}

export const av3aChannel = {
  /** The `moov` box was indexed (fires before the first `pcm`). */
  onOpened(handler: OpenedHandler): void {
    openedHandler = handler;
  },
  /** Register the per-frame PCM consumer (kept across sessions). */
  onPcm(handler: (frame: PcmFrame) => void): void {
    pcmHandler = handler;
  },
  /** The last frame of the track was decoded. */
  onDone(handler: DoneHandler): void {
    doneHandler = handler;
  },
  /** A decode error from the utility process. */
  onError(handler: ErrorHandler): void {
    errorHandler = handler;
  },
  /** Pause decoding after the current frame (consumer backpressure). */
  pause(): void {
    send({ type: "pause" });
  },
  /** Resume decoding. */
  resume(): void {
    send({ type: "resume" });
  },
  /** Seek the decode session to an absolute track frame index. */
  seek(frameIndex: number): void {
    send({ type: "seek", frameIndex });
  },
};

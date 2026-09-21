import type { AudioPlayInfo } from "../../preload/Player";
import { mainWindow } from "../window";
import { normalizePath } from "../util";
import { toError } from "@shared/util";
import { playCacheManager } from "../cache";
import { OnlineStreamer } from "../audio/OnlineStreamer";
import { Av3aPlaybackProcess } from "./Av3aPlaybackProcess";
import { isAv3aFile } from "./detect";
import { localAv3aSource, onlineStreamerToAv3aSource } from "./sources";
import type { Av3aM4aSource } from "./Av3aM4aSession";

type Av3aPlaybackState = {
  playId: string;
  /** The file the decode process reads (a streamed temp file or a local one). */
  source: Av3aM4aSource;
  process: Av3aPlaybackProcess;
  /** Present only when decoding a streamed (URL) temp file. */
  streamer?: OnlineStreamer;
};

/**
 * Main-process manager for AV3A playback: a decode utility process plus the
 * file it reads (a streamed temp file or a local one). Distinct from
 * `MediaEngine` (the media-element engine): AV3A is never served over
 * `audio://audio`; PCM and renderer flow control travel on a direct
 * renderer<->utility channel.
 */
export class Av3aEngine {
  private state: Av3aPlaybackState | null = null;
  /** Monotonic sequence for AV3A start requests (only the newest may win). */
  private requestSeq = 0;

  get active(): boolean {
    return this.state !== null;
  }

  /** Push a fallback `av3a.<event>` to the player window. */
  private sendEvent(event: string, ...args: unknown[]) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(`av3a.${event}`, ...args);
  }

  /** Stop the currently active AV3A session. Has no freshness side effects. */
  async stopActive(): Promise<void> {
    const current = this.state;
    if (!current) return;
    this.state = null;
    await current.process.stop().catch((error: unknown) => {
      LOGGER.error(
        { err: toError(error) },
        `Failed to stop av3a decode process`
      );
    });
    if (current.streamer) {
      await current.streamer.destroy().catch((error: unknown) => {
        LOGGER.error(
          { err: toError(error) },
          `Failed to destroy av3a OnlineStreamer`
        );
      });
    }
  }

  /**
   * External stop (user stop / play-info change): cancels any pending startup
   * too, by advancing the request sequence before stopping active playback.
   */
  async stop(): Promise<void> {
    this.requestSeq += 1;
    await this.stopActive();
  }

  async start(playInfo: AudioPlayInfo): Promise<void> {
    // Claim the freshness sequence at request entry, before any await, so the
    // claim order matches request order. Claiming after a (possibly slow) stop
    // of the previous song would let an older request take a larger number and
    // win over a newer request.
    const requestSeq = ++this.requestSeq;
    const isStale = () => requestSeq !== this.requestSeq;

    // Stop whatever is playing WITHOUT invalidating our own claim: this stop is
    // part of starting our song, not an external cancel.
    await this.stopActive();

    // A newer request or an external stop arrived while we were stopping the
    // previous song; abandon quietly (nothing has been created yet).
    if (isStale()) return;

    const isUrlAv3a = playInfo.type === 4 && playInfo.audioFormat === "av3a";
    const isLocal = playInfo.type === 0;
    if (!isUrlAv3a && !isLocal) {
      this.sendEvent("error", "Unsupported play info for AV3A playback");
      return;
    }

    let source: Av3aM4aSource;
    let streamer: OnlineStreamer | undefined;
    const destroyStreamer = async () => {
      await streamer?.destroy().catch(() => {});
    };

    if (isLocal) {
      // A local file's codec is not signalled by playInfo; sniff the container.
      const localPath = normalizePath(playInfo.path);
      if (!(await isAv3aFile(localPath))) {
        if (!isStale()) {
          this.sendEvent(
            "error",
            "Selected file does not contain an AV3A track"
          );
        }
        return;
      }
      if (isStale()) return;
      source = await localAv3aSource(localPath);
    } else {
      const songId = playInfo.songId;
      const s = new OnlineStreamer(playInfo.musicurl);
      streamer = s;

      s.on("progress", (e) => {
        if (this.state?.streamer !== s) return;
        this.sendEvent("progress", e.data.loaded, e.data.total);
      });

      s.on("complete", async () => {
        if (this.state?.streamer !== s) return;
        try {
          const buf = await s.readBuffer();
          await playCacheManager?.cacheTrack(songId, buf, {
            md5: playInfo.md5,
            bitrate: playInfo.bitrate,
            playInfoStr: playInfo.playInfoStr,
            volumeGain: 0,
            fileSize: buf.length,
          });
        } catch (error) {
          LOGGER.error(
            { err: toError(error), songId },
            `Failed to cache av3a track`
          );
        }
      });

      s.on("error", (e) => {
        LOGGER.error({ err: e.data }, `Av3a OnlineStreamer errored`);
      });

      try {
        await s.whenReady();
      } catch (error) {
        // Only the newest request reports its own preparation failure.
        if (!isStale()) {
          this.sendEvent("error", toError(error).message);
        }
        await destroyStreamer();
        return;
      }
      if (isStale()) {
        await destroyStreamer();
        return;
      }
      source = onlineStreamerToAv3aSource(s);
    }

    // A newer request superseded this one — or a stop was requested while this
    // one was still preparing.
    if (isStale()) {
      await destroyStreamer();
      return;
    }

    const rendererWebContents = mainWindow?.webContents;
    if (!rendererWebContents || mainWindow?.isDestroyed()) {
      this.sendEvent("error", "Player window is not available");
      await destroyStreamer();
      return;
    }

    // Decode + pacing run in a dedicated utility process. PCM and renderer flow
    // control travel on a direct renderer<->utility channel, so playback keeps
    // going even while this (main) process is blocked, e.g. by a window drag.
    const process = new Av3aPlaybackProcess({
      source,
      rendererWebContents,
      sendEvent: (event, ...args) => this.sendEvent(event, ...args),
    });

    this.state = { playId: playInfo.playId, source, process, streamer };
    try {
      await process.start();
    } catch (error) {
      if (this.state?.process === process) this.state = null;
      await process.stop().catch(() => {});
      await destroyStreamer();
      if (!isStale()) {
        this.sendEvent("error", toError(error).message);
      }
      return;
    }
    if (isStale()) {
      // Superseded while starting; tear down quietly (the newer request owns it).
      if (this.state?.process === process) this.state = null;
      await process.stop().catch(() => {});
      await destroyStreamer();
    }
  }
}

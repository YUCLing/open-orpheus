import path, { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { Protocol } from "electron";
import mime from "mime";

import { OnlineStreamer } from "./audio/OnlineStreamer";
import type { AudioPlayInfo } from "../preload/Player";
import { mainWindow } from "./window";
import { playCacheManager } from "./cache";
import { normalizePath, sanitizeRelativePath } from "./util";
import { data as dataDir, pack as packageDir } from "./folders";
import { events as lifecycleEvents } from "./lifecycle";
import { kv as settings } from "./settings";
import { toError } from "../util";
import { decodeNcae } from "./ncae";
import { registerIpcHandlers } from "../bridge/register";
import type { Av3aContract } from "../bridge/contracts/av3a-api";
import { Av3aPlaybackProcess } from "./av3a/Av3aPlaybackProcess";
import { onlineStreamerToAv3aSource } from "./av3a/onlineStreamerSource";

enum AudioType {
  Local,
  URL,
}

type CurrentAudioState = {
  playInfo: AudioPlayInfo;
} & (
  | {
      type: AudioType.Local;
      path: string;
    }
  | {
      type: AudioType.URL;
      streamer: OnlineStreamer;
    }
);
let state: CurrentAudioState | null = null;

function sendProgress(prog: number) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("audio.onProgress", prog);
}

type Av3aPlaybackState = {
  playId: string;
  streamer: OnlineStreamer;
  process: Av3aPlaybackProcess;
};

let av3aState: Av3aPlaybackState | null = null;
/** Monotonic sequence for AV3A start requests (only the newest may win). */
let av3aRequestSeq = 0;

function sendAv3aEvent(event: string, ...args: unknown[]) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(`av3a.${event}`, ...args);
}

async function stopAv3aPlayback() {
  const current = av3aState;
  if (!current) return;
  av3aState = null;
  await current.process.stop().catch((error: unknown) => {
    LOGGER.error({ err: toError(error) }, `Failed to stop av3a decode process`);
  });
  await current.streamer.destroy().catch((error: unknown) => {
    LOGGER.error(
      { err: toError(error) },
      `Failed to destroy av3a OnlineStreamer`
    );
  });
}

async function startAv3aPlayback(playInfo: AudioPlayInfo) {
  // Guard against "old request wins": only the most recently requested song
  // may start. Each call claims a new sequence number; a stale request tears
  // itself down quietly once its async preparation finishes.
  const requestSeq = ++av3aRequestSeq;
  const isStale = () => requestSeq !== av3aRequestSeq;

  await stopAv3aPlayback();

  if (playInfo.type !== 4 || playInfo.audioFormat !== "av3a") {
    sendAv3aEvent(
      "error",
      "AV3A decode currently supports URL (type 4, av3a) playback only"
    );
    return;
  }

  const songId = playInfo.songId;
  const streamer = new OnlineStreamer(playInfo.musicurl);

  streamer.on("progress", (e) => {
    if (av3aState?.streamer !== streamer) return;
    sendAv3aEvent("progress", e.data.loaded, e.data.total);
  });

  streamer.on("complete", async () => {
    if (av3aState?.streamer !== streamer) return;
    try {
      const buf = await streamer.readBuffer();
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

  streamer.on("error", (e) => {
    LOGGER.error({ err: e.data }, `Av3a OnlineStreamer errored`);
  });

  try {
    await streamer.whenReady();
  } catch (error) {
    // Only the newest request reports its own preparation failure.
    if (!isStale()) {
      sendAv3aEvent("error", toError(error).message);
    }
    await streamer.destroy().catch(() => {});
    return;
  }

  // A newer request superseded this one while it was preparing.
  if (isStale()) {
    await streamer.destroy().catch(() => {});
    return;
  }
  // We are the newest request. An older request that slipped through and
  // already started (before we finished preparing) must yield to us.
  await stopAv3aPlayback();
  if (isStale()) {
    // Superseded again while stopping the older session.
    await streamer.destroy().catch(() => {});
    return;
  }

  const rendererWebContents = mainWindow?.webContents;
  if (!rendererWebContents || mainWindow?.isDestroyed()) {
    sendAv3aEvent("error", "Player window is not available");
    await streamer.destroy().catch(() => {});
    return;
  }

  // Decode + pacing run in a dedicated utility process. PCM and renderer flow
  // control travel on a direct renderer<->utility channel, so playback keeps
  // going even while this (main) process is blocked, e.g. by a window drag.
  const process = new Av3aPlaybackProcess({
    source: onlineStreamerToAv3aSource(streamer),
    rendererWebContents,
    sendEvent: sendAv3aEvent,
  });

  av3aState = { playId: playInfo.playId, streamer, process };
  try {
    await process.start();
  } catch (error) {
    if (av3aState?.process === process) av3aState = null;
    await process.stop().catch(() => {});
    await streamer.destroy().catch(() => {});
    if (!isStale()) {
      sendAv3aEvent("error", toError(error).message);
    }
    return;
  }
  if (isStale()) {
    // Superseded while starting; tear down quietly (the newer request owns it).
    if (av3aState?.process === process) av3aState = null;
    await process.stop().catch(() => {});
    await streamer.destroy().catch(() => {});
  }
}

export async function readEffect(pathInfo: { path: string; pathtype: number }) {
  if (pathInfo.pathtype !== 2) {
    throw new Error(
      "Unsupported audio.readEffect pathtype: " + pathInfo.pathtype
    );
  }
  const path = sanitizeRelativePath(dataDir, pathInfo.path);
  if (path === false) {
    throw new Error("Illegal path: " + pathInfo.path);
  }
  if (pathInfo.path.endsWith(".ncae")) {
    try {
      const content = await readFile(path);
      const ncae = await decodeNcae(content);
      return ncae;
    } catch (err) {
      throw new Error("Failed to load NCAE", {
        cause: err,
      });
    }
  }
  return await readFile(path, {
    encoding: "utf-8",
  });
}

export default function registerAudioStreamerScheme(protocol: Protocol) {
  protocol.handle("audio", async (request) => {
    const requestUrl = new URL(request.url);

    switch (requestUrl.hostname) {
      case "worklet": {
        const workletPath = path.join(
          import.meta.dirname,
          "worklets",
          path.normalize(requestUrl.pathname)
        );
        try {
          const isWasm = workletPath.endsWith(".wasm");
          const content = await readFile(workletPath, isWasm ? null : "utf-8");
          return new Response(content, {
            status: 200,
            headers: {
              "Content-Type": isWasm
                ? "application/wasm"
                : "application/javascript",
            },
          });
        } catch (e) {
          LOGGER.debug(
            { scheme: "audio", path: workletPath },
            "Failed to get worklet: %s",
            e
          );
          return new Response("Failed to load worklet", { status: 500 });
        }
      }
      case "audio": {
        if (!state) return new Response("No play info yet", { status: 400 });

        if (state.type === AudioType.Local) {
          const path = state.path;
          const fileStat = await stat(path);
          const fileSize = fileStat.size;
          const mimeType = mime.getType(path) || "application/octet-stream";

          sendProgress(1);

          const rangeHeader = request.headers.get("Range");
          if (rangeHeader) {
            const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
            if (match) {
              const start = parseInt(match[1], 10);
              const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

              if (start <= end && start < fileSize) {
                const clampedEnd = Math.min(end, fileSize - 1);
                const chunkSize = clampedEnd - start + 1;
                const nodeStream = createReadStream(path, {
                  start,
                  end: clampedEnd,
                });

                return new Response(Readable.toWeb(nodeStream), {
                  status: 206,
                  headers: {
                    "Content-Type": mimeType,
                    "Content-Length": String(chunkSize),
                    "Content-Range": `bytes ${start}-${clampedEnd}/${fileSize}`,
                    "Accept-Ranges": "bytes",
                  },
                });
              }
            }
            // Invalid or unsatisfiable range — return 416
            return new Response("Range Not Satisfiable", {
              status: 416,
              headers: {
                "Content-Range": `bytes */${fileSize}`,
              },
            });
          }

          const nodeStream = createReadStream(path);

          return new Response(Readable.toWeb(nodeStream), {
            status: 200,
            headers: {
              "Content-Type": mimeType,
              "Content-Length": String(fileSize),
              "Accept-Ranges": "bytes",
            },
          });
        } else if (state.type === AudioType.URL) {
          return state.streamer.handleRequest(request);
        }
        return new Response("Unknown play info state", { status: 500 });
      }
      case "resource": {
        const type = mime.getType(requestUrl.pathname);
        if (!type?.startsWith("audio/"))
          return new Response("Unsupported resource", { status: 400 });

        const fullPath = sanitizeRelativePath(
          join(packageDir, "resource"),
          requestUrl.pathname
        );
        if (fullPath === false)
          return new Response("Not Found", { status: 404 });

        try {
          const content = await readFile(fullPath);
          return new Response(content, {
            headers: {
              "Content-Type": type,
            },
          });
        } catch (err) {
          return new Response(toError(err).message, { status: 500 });
        }
      }
    }
    return new Response("Not Found", { status: 404 });
  });
}

lifecycleEvents.on("mainwindowcreated", (e) => {
  const mainWindow = e.data;
  mainWindow.webContents.ipc.handle("audio.setDevice", async (e, deviceId) => {
    return settings.set("audio.currentDevice", deviceId);
  });

  mainWindow.webContents.ipc.handle("audio.getDevice", async () => {
    return settings.get("audio.currentDevice");
  });

  mainWindow.webContents.ipc.handle(
    "audio.readEffect",
    async (
      event,
      pathInfo: {
        pathtype: number;
        path: string;
      }
    ) => {
      try {
        return await readEffect(pathInfo);
      } catch (err) {
        LOGGER.error(
          { err: toError(err), pathInfo },
          `Failed to read audio effect`
        );
        return null;
      }
    }
  );

  mainWindow.webContents.ipc.handle(
    "audio.updatePlayInfo",
    (event, playInfo: AudioPlayInfo | null) => {
      void stopAv3aPlayback();
      if (state?.type === AudioType.URL) {
        // We don't await this, let it destroy in background
        state.streamer.destroy().catch((e) => {
          LOGGER.error(
            { err: toError(e) },
            `Failed to destroy previous OnlineStreamer`
          );
        });
      }
      state = null;
      if (!playInfo) return;

      if (playInfo.type === 4 && playInfo.audioFormat === "av3a") {
        // AV3A is decoded by a dedicated decode utility process (forked and
        // managed here), not by Chromium. The player window starts that
        // process through the `av3a` bridge.
        return;
      }

      if (playInfo.type === 0) {
        // Local File Play
        playInfo.path = normalizePath(playInfo.path);
        state = {
          type: AudioType.Local,
          playInfo,
          path: playInfo.path,
        };
      } else if (playInfo.type === 4) {
        // URL Play
        const songId = playInfo.songId;
        const streamer = new OnlineStreamer(playInfo.musicurl);

        streamer.on("progress", (e) => {
          sendProgress(e.data.loaded / e.data.total);
        });

        streamer.on("complete", async () => {
          if (state?.playInfo.songId !== songId) return;
          try {
            const buf = await streamer.readBuffer();
            playCacheManager
              ?.cacheTrack(songId, buf, {
                md5: playInfo.md5,
                bitrate: playInfo.bitrate,
                playInfoStr: playInfo.playInfoStr,
                volumeGain: 0,
                fileSize: buf.length,
              })
              .catch((err) => {
                LOGGER.error({ err: toError(err) }, `Failed to cache track`);
              });
          } catch (e) {
            LOGGER.error({ err: toError(e) }, `Cannot get streamed track`);
          }
        });

        streamer.on("error", (e) => {
          LOGGER.error({ err: e.data }, `OnlineStreamer errored`);
        });

        state = {
          type: AudioType.URL,
          playInfo,
          streamer,
        };
      }
    }
  );

  registerIpcHandlers<Av3aContract>(mainWindow.webContents, "av3a", {
    start: async (_event, playInfo: AudioPlayInfo) => {
      await startAv3aPlayback(playInfo);
    },
    stop: async () => {
      await stopAv3aPlayback();
    },
  });
});

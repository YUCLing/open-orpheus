import path, { join } from "node:path";
import { readFile, stat } from "node:fs/promises";

import { Protocol } from "electron";
import mime from "mime";

import { OnlineStreamer } from "./audio/OnlineStreamer";

import type { AudioPlayInfo } from "../preload/Player";
import { mainWindow } from "./window";
import { playCacheManager } from "./cache";
import { normalizePath, sanitizeRelativePath } from "./util";
import { data as dataDir, pack as packageDir } from "./folders";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { events as lifecycleEvents } from "./lifecycle";
import { kv as settings } from "./settings";
import { toError } from "../util";
import { decodeNcae } from "./ncae";
import logger from "./logger";

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
          __dirname,
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
          logger.debug(
            { name: "scheme", scheme: "audio", path: workletPath },
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
        console.error(err);
        return null;
      }
    }
  );

  mainWindow.webContents.ipc.handle(
    "audio.updatePlayInfo",
    (event, playInfo: AudioPlayInfo | null) => {
      if (state?.type === AudioType.URL) {
        // We don't await this, let it destroy in background
        state.streamer.destroy().catch((e) => {
          console.error("Failed to destroy previous OnlineStreamer", e);
        });
      }
      state = null;
      if (!playInfo) return;

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
                console.error("[PlayCacheManager] Failed to cache track:", err);
              });
          } catch (e) {
            console.log("Cannot get streamed track:", e);
          }
        });

        streamer.on("error", (e) => {
          console.log("OnlineStreamer error:", e.data);
        });

        state = {
          type: AudioType.URL,
          playInfo,
          streamer,
        };
      }
    }
  );
});

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
          const code = await readFile(workletPath, "utf-8");
          return new Response(code, {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          });
        } catch (e) {
          console.error("Failed to load worklet", e);
          return new Response("Failed to load worklet", { status: 500 });
        }
      }
      case "audio": {
        if (!state) return new Response("No play info yet", { status: 400 });

        if (state.type === AudioType.Local) {
          const path = state.path;
          const fileStat = await stat(path);
          const nodeStream = createReadStream(path);

          sendProgress(1);

          return new Response(Readable.toWeb(nodeStream), {
            status: 200,
            headers: {
              "Content-Type": mime.getType(path) || "application/octet-stream",
              "Content-Length": String(fileStat.size),
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
      if (pathInfo.pathtype !== 2) {
        console.warn("Unsupported audio.readEffect pathtype:", pathInfo);
        return null;
      }
      if (pathInfo.path.endsWith(".ncae")) {
        console.warn("ncae format is not supported yet");
        return null;
      }
      const path = sanitizeRelativePath(dataDir, pathInfo.path);
      if (path === false) {
        return null;
      }
      return await readFile(path, {
        encoding: "utf-8",
      }).catch((err) => {
        console.error("Failed to read audio effect:", err);
        return null;
      });
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

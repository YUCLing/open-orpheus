import path, { join } from "node:path";
import { readFile, stat } from "node:fs/promises";

import { ipcMain, Protocol } from "electron";
import mime from "mime";

import { OnlineStreamer } from "./audio/OnlineStreamer";

import type { AudioPlayInfo } from "../preload/Player";
import { mainWindow } from "./window";
import { playCacheManager } from "./cache";
import { normalizePath, sanitizeRelativePath } from "./util";
import { pack as packageDir } from "./folders";
import { stringifyError } from "../util";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

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

ipcMain.handle(
  "audio.updatePlayInfo",
  async (event, playInfo: AudioPlayInfo | null) => {
    if (state?.type === AudioType.URL) {
      try {
        await state.streamer.destroy();
      } catch (e) {
        console.log("Failed to destroy OnlineStreamer", e);
      }
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
            console.error("[audio] failed to cache track:", err);
          });
      });

      state = {
        type: AudioType.URL,
        playInfo,
        streamer,
      };
    }
  }
);

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
              "Content-Type":
                mime.getType(path) || "application/octet-stream",
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
          return new Response(stringifyError(err), { status: 500 });
        }
      }
    }
    return new Response("Not Found", { status: 404 });
  });
}

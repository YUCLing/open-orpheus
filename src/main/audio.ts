import path, { join } from "node:path";
import { readFile } from "node:fs/promises";

import { ipcMain, Protocol } from "electron";
import mime from "mime";

import AudioStreamer from "./audio/streamer";

import type { AudioPlayInfo } from "../preload/Player";
import { mainWindow } from "./window";
import { playCacheManager } from "./cache";
import { normalizePath, sanitizeRelativePath } from "./util";
import { pack as packageDir } from "./folders";
import { stringifyError } from "../util";

const audioStreamer = new AudioStreamer();

audioStreamer.addEventListener("progress", ((e: CustomEvent<number>) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("audio.onProgress", e.detail);
}) as EventListener);

audioStreamer.addEventListener("complete", () => {
  const sb = audioStreamer.buffer;
  const playInfo = audioStreamer.audioPlayInfo;
  if (!sb || !playInfo || playInfo.type !== 4) return;

  playCacheManager
    ?.cacheTrack(sb.songId, sb.buffer, {
      md5: playInfo.md5,
      bitrate: playInfo.bitrate,
      playInfoStr: playInfo.playInfoStr,
      volumeGain: 0,
      fileSize: sb.totalSize,
    })
    .catch((err) => {
      console.error("[audioStreamer] failed to cache track:", err);
    });
});

ipcMain.on("audio.updatePlayInfo", (event, playInfo: AudioPlayInfo | null) => {
  if (playInfo && playInfo.type === 0) {
    playInfo.path = normalizePath(playInfo.path);
  }
  audioStreamer.setPlayInfo(playInfo);
  event.returnValue = undefined;
});

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
        const songId = requestUrl.pathname.replace(/^\//, "");
        if (!songId) return new Response("Missing song ID", { status: 400 });

        return audioStreamer.handleRequest(songId, request);
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

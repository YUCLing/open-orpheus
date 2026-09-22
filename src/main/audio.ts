import path, { join } from "node:path";
import { readFile } from "node:fs/promises";

import { Protocol } from "electron";
import mime from "mime";

import type { AudioPlayInfo } from "../preload/Player";
import { sanitizeRelativePath } from "./platform/util";
import { data as dataDir, pack as packageDir } from "./platform/folders";
import { events as lifecycleEvents } from "./lifecycle";
import { toError } from "@shared/util";
import { decodeNcae } from "./domain/ncae";
import { registerIpcHandlers } from "../bridge/register";
import type { Av3aContract } from "../bridge/contracts/av3a-api";
import { MediaEngine } from "./audio/MediaEngine";
import { Av3aEngine } from "./av3a/Av3aEngine";
import { isAv3aFile } from "./av3a/detect";
import type { SettingsService, WindowService } from "./bootstrap/types";

export interface AudioDeps {
  windows: Pick<WindowService, "currentWindow">;
  settings: Pick<SettingsService, "kv">;
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

/**
 * The two playback engines are distinct and mutually exclusive. The renderer
 * is the router: `Player` sniffs/classifies the play info and tells us which
 * engine a load targets. Each engine owns its whole lifecycle:
 *  - `MediaEngine` serves the hidden `<audio>` element over `audio://audio`.
 *  - `Av3aEngine` runs the AV3A decode utility process (direct renderer
 *    channel) and is started by the renderer through the `av3a` bridge.
 * This module only wires them to IPC + the protocol; it holds no engine state.
 */
export function createAudio(deps: AudioDeps) {
  const mediaEngine = new MediaEngine({ windows: deps.windows });
  const av3aEngine = new Av3aEngine({ windows: deps.windows });

  lifecycleEvents.on("mainwindowcreated", (e) => {
    const mainWindow = e.data;
    mainWindow.webContents.ipc.handle(
      "audio.setDevice",
      async (e, deviceId) => {
        return deps.settings.kv.set("audio.currentDevice", deviceId);
      }
    );

    mainWindow.webContents.ipc.handle("audio.getDevice", async () => {
      return deps.settings.kv.get("audio.currentDevice");
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
      "audio.isAv3aFile",
      async (_event, filePath: unknown) => {
        if (typeof filePath !== "string" || filePath.length === 0) return false;
        try {
          return await isAv3aFile(filePath);
        } catch (err) {
          LOGGER.debug(
            { err: toError(err), path: filePath },
            `Failed to sniff file for AV3A`
          );
          return false;
        }
      }
    );

    mainWindow.webContents.ipc.handle(
      "audio.updatePlayInfo",
      async (
        _event,
        playInfo: AudioPlayInfo | null,
        engine: "media" | "av3a"
      ) => {
        // A new load always retires the previous engine first. Stopping either is
        // cheap when idle. The renderer awaits this handler before starting the
        // new engine, so this retirement always lands before it.
        void av3aEngine.stop();
        void mediaEngine.stop();
        if (!playInfo) return;

        // The renderer is the router (it sniffs local files / reads
        // `audioFormat`) and tells us which engine this load targets; main never
        // re-derives it. AV3A is decoded by a dedicated utility process
        // (Av3aEngine) and started by the renderer through the `av3a` bridge once
        // its worklet + channel are ready, so nothing is registered here — the
        // <audio> element is never pointed at an AV3A stream.
        if (engine === "av3a") return;
        await mediaEngine.activate(playInfo);
      }
    );

    registerIpcHandlers<Av3aContract>(mainWindow.webContents, "av3a", {
      start: async (_event, playInfo: AudioPlayInfo) => {
        await av3aEngine.start(playInfo);
      },
      stop: async () => {
        await av3aEngine.stop();
      },
    });
  });

  return {
    registerAudioStreamerScheme(protocol: Protocol) {
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
              const content = await readFile(
                workletPath,
                isWasm ? null : "utf-8"
              );
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
            return mediaEngine.serve(request);
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
    },
  };
}

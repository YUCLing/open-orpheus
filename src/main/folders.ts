import { resolve } from "node:path";

import { app } from "electron";

export const tempDir =
  "OPEN_ORPHEUS_CUSTOM_TEMP_DIR" in process.env
    ? resolve(process.env.OPEN_ORPHEUS_CUSTOM_TEMP_DIR!)
    : resolve(app.getPath("temp"), "open-orpheus-temp");

export const downloadTemp = resolve(tempDir, "download");
export const streamerTemp = resolve(tempDir, "streamer");

export const data = resolve(
  "OPEN_ORPHEUS_CUSTOM_DATA_DIR" in process.env
    ? process.env.OPEN_ORPHEUS_CUSTOM_DATA_DIR!
    : app.isPackaged
      ? app.getPath("userData")
      : "data"
);

export const log = resolve(data, "logs");
export const pack = resolve(data, "package");
export const userdata = resolve(data, "userdata");
export const storage = resolve(data, "storage");
export const wasm = resolve(data, "wasm");
export const aegisPublicKey = resolve(data, "Aegis", "pubkey");

// Flag files
export const disableHardwareAccelerationFlag = resolve(data, "disable-hw-accel");

// Simple data files
export const lastWebpackHash = resolve(data, "last-webpack-hash");

export const defaultCache = resolve(data, "cache");

export let cache = defaultCache;
export let download = "";

export function setCachePath(path: string) {
  cache = path;
}

export function setDownloadPath(path: string) {
  download = path;
}

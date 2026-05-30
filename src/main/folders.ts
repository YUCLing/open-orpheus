import { app } from "electron";
import { resolve } from "node:path";

export const downloadTemp = resolve(
  app.getPath("temp"),
  "open-orpheus-download-temp"
);

export const data = resolve(app.isPackaged ? app.getPath("userData") : "data");

export const pack = resolve(data, "package");
export const userdata = resolve(data, "userdata");
export const storage = resolve(data, "storage");
export const wasm = resolve(data, "wasm");

// Flag files
export const disableHardwareAccelerationFlag = resolve(
  data,
  "disable-hw-accel"
);

export const defaultCache = resolve(data, "cache");

export let cache = defaultCache;
export let download = "";

export function setCachePath(path: string) {
  cache = path;
}

export function setDownloadPath(path: string) {
  download = path;
}

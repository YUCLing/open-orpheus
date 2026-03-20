import { app } from "electron";
import { resolve } from "node:path";

export const data = resolve(app.isPackaged ? app.getPath("userData") : "data");
export const pack = resolve(data, "package");
export const userdata = resolve(data, "userdata");
export const lyricCache = resolve(data, "lyrics");

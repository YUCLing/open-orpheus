import { app } from "electron";
import { join, resolve } from "node:path";

export const pack = resolve(app.isPackaged ? app.getPath("exe") : ".", "package");

export const data = "data";
export const userdata = join(data, "userdata");
export const tempFile = join(data, "lyrics");

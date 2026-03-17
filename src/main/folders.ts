import { app } from "electron";
import { dirname, resolve } from "node:path";

export const pack = resolve(
  app.isPackaged ? dirname(app.getPath("exe")) : ".",
  "package"
);

export const data = resolve("data");
export const userdata = resolve(data, "userdata");
export const tempFile = resolve(data, "lyrics");

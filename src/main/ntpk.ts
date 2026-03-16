// TODO: Cleanup ntpk code

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pack as base } from "./folders";
import WebPack from "./packs/WebPack";

function choosePackFile() {
  const webPack = resolve(base, "web.pack");
  if (existsSync(webPack)) {
    return webPack;
  }
  const orpheusPack = resolve(base, "orpheus.ntpk");
  if (existsSync(orpheusPack)) {
    return orpheusPack;
  }
  throw new Error("No pack file found");
}

const webPackFile = choosePackFile();
const pack = new WebPack(webPackFile);

export const readPack = pack.readPack.bind(pack);
export const readFile = pack.readFile.bind(pack);

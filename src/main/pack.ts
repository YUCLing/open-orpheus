import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pack as base } from "./folders";
import WebPack from "./packs/WebPack";
import SkinPack from "./packs/SkinPack";

function chooseWebPackFile() {
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

const webPackFile = chooseWebPackFile();
export const webPack = new WebPack(webPackFile);

export let skinPack: SkinPack | null = null;

export async function loadSkinPack(name: string) {
  const skinPackPath = resolve(base, `${name}.skin`);
  if (!existsSync(skinPackPath)) {
    throw new Error(`Skin pack file not found: ${skinPackPath}`);
  }
  skinPack = new SkinPack(skinPackPath);
  await skinPack.readPack();
}

export function getSkinPack() {
  if (!skinPack) {
    throw new Error("Skin pack not loaded");
  }
  return skinPack;
}

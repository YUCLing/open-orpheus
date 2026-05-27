import photon from "@silvia-odwyer/photon-node";

import packManager from "../pack";
import type SkinPack from "../packs/SkinPack";
import type { MenuSkin } from "$sharedTypes/menu";
import { extractColor } from "../skin/color";
import { argbToCss } from "../skin/dui";

export const menuSkin: MenuSkin = {
  background: "#fffffffa",
  foreground: "#1e1e1e",
  foregroundDisabled: "#a0a0a0",
  separator: "#0000001a",
  itemHover: "#e1ebfc",
};

function applyAlphaOverride(color: string, alphaDec?: string): string {
  if (!alphaDec) return color;
  const value = Number.parseInt(alphaDec, 10);
  if (!Number.isFinite(value)) return color;
  const alpha = Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  return `${color.slice(0, 7)}${alpha}`;
}

export function registerMenuSkinUpdater() {
  packManager.on("skin2packloaded", async (event) => {
    const skinPack = event.data.pack as SkinPack;
    const [bg, hov, sep, elBuf] = await Promise.all(
      [
        "/menu/bk.png",
        "/menu/hover.png",
        "/menu/separator.png",
        "/menu/element.xml",
      ].map((p) => skinPack.readFile(p))
    );
    const [bgColor, hoverColor, separatorColor] = await Promise.all(
      [bg, hov, sep]
        .map((buf) => photon.PhotonImage.new_from_byteslice(buf))
        .map(extractColor)
    );

    const xml = elBuf.toString("utf-8");
    const fgMatch = xml.match(/\btextcolor="(#[0-9A-Fa-f]{8})"/);
    const fgDisabledMatch = xml.match(
      /\bdisabledtextcolor="(#[0-9A-Fa-f]{8})"/
    );
    const fgAlphaMatch = xml.match(/\btranstext="(\d{1,3})"/);
    const fgDisabledAlphaMatch = xml.match(/\bdisabletranstext="(\d{1,3})"/);

    menuSkin.background = bgColor;
    menuSkin.itemHover = hoverColor;
    menuSkin.separator = separatorColor;
    if (fgMatch) {
      menuSkin.foreground = applyAlphaOverride(
        argbToCss(fgMatch[1]),
        fgAlphaMatch?.[1]
      );
    }
    if (fgDisabledMatch) {
      menuSkin.foregroundDisabled = applyAlphaOverride(
        argbToCss(fgDisabledMatch[1]),
        fgDisabledAlphaMatch?.[1]
      );
    }
  });
}

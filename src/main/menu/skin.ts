import photon from "@silvia-odwyer/photon-node";

import packManager from "../pack";
import SkinPack from "../packs/SkinPack";
import type { MenuSkin } from "./types";
import { extractColor } from "../skin/color";

export const menuSkin: MenuSkin = {
  background: "#fffffffa",
  foreground: "#1e1e1e",
  foregroundDisabled: "#a0a0a0",
  separator: "#0000001a",
  itemHover: "#e1ebfc",
};

/** Convert #AARRGGBB (ARGB) to CSS #RRGGBBAA. */
function argbToCss(c: string): string {
  if (c.length === 9 && c[0] === "#") {
    // input: #AA RR GG BB  (indices 1-2, 3-4, 5-6, 7-8)
    return `#${c.slice(3, 5)}${c.slice(5, 7)}${c.slice(7)}${c.slice(1, 3)}`;
  }
  return c;
}

function applyAlphaOverride(color: string, alphaDec?: string): string {
  if (!alphaDec) return color;
  const value = Number.parseInt(alphaDec, 10);
  if (!Number.isFinite(value)) return color;
  const alpha = Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  return `${color.slice(0, 7)}${alpha}`;
}

export function registerMenuSkinUpdater() {
  packManager.addEventListener("skin2packloaded", async () => {
    const skinPack = packManager.getPack<SkinPack>("skin2");
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

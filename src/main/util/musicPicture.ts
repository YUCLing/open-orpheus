import type { MetaPicture } from "music-tag-native";

export function selectBestMusicPic(pics: MetaPicture[]): MetaPicture | null {
  if (pics.length === 0) return null;
  let pic: MetaPicture | null = null;
  for (const p of pics) {
    // Use CoverFront directly
    if (p.coverType === "Cover Art (Front)") return p;
    // Use the first found if no CoverFront
    if (pic === null) pic = p;
  }
  return pic;
}

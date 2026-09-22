import { deData, enData, ID3_AES_KEY } from "./crypto";

const ID3_COMMENT_PREFIX = "163 key(Don't modify):";

export type ID3MusicMetadata = {
  musicId: string;
  musicName: string;
  artist: [string, string][];
  albumId: string;
  album: string;
  albumPicDocId: string;
  albumPic: string;
  bitrate: number;
  mp3DocId: string;
  duration: number;
  mvId: string;
  alias: string[];
  transNames: string[];
  format: string;
  fee: number;
  volumeDelta: number;
  privilege: {
    flag: number;
  };
};

/**
 * Convert music metadata JSON string prefixed with `music:` to ID3 comment.
 *
 * @param json
 * @returns
 */
export function ID3JsonToComment(json: string) {
  return `${ID3_COMMENT_PREFIX}${enData(json, ID3_AES_KEY, false)}`;
}

/**
 * Convert ID3 comment to music metadata in JSON string, with `music:` prefix.
 *
 * @param comment
 * @returns
 */
export function commentToID3Json(comment: string | null): string | null {
  if (!comment) return null;
  comment = comment.trim();
  if (!comment.startsWith(ID3_COMMENT_PREFIX)) return null;
  const encoded = comment.substring(ID3_COMMENT_PREFIX.length);
  try {
    const json = deData(encoded, ID3_AES_KEY, false)?.toString("utf-8");
    if (!json) return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * Convert ID3 comment to music metadata.
 *
 * @param comment
 * @returns
 */
export function commentToID3Metadata(
  comment: string | null
): ID3MusicMetadata | null {
  const json = commentToID3Json(comment);
  if (!json) return null;
  try {
    if (!json.startsWith("music:")) return null;
    return JSON.parse(json.substring("music:".length));
  } catch {
    return null;
  }
}

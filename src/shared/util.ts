export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

/**
 * Get or set the image size of a Netease CDN URL.
 *
 * To get, leave `sizeOrWidth` and `height` empty.
 * To set, set `sizeOrWidth` and/or `height`.
 *
 * @param url
 * @param sizeOrWidth If provided, sets the image size or width
 * @param height If provided, use this as the height, or `sizeOrWidth` will be used for height
 */
export function imageSize(url: string): [number, number] | null;
export function imageSize(
  url: string,
  sizeOrWidth: number,
  height?: number
): string;
export function imageSize(
  url: string,
  sizeOrWidth?: number,
  height?: number
): string | [number, number] | null {
  const parsedUrl = new URL(url);
  if (typeof sizeOrWidth === "number") {
    height = height ?? sizeOrWidth;
    parsedUrl.searchParams.delete("thumbnail");
    parsedUrl.searchParams.set("param", `${sizeOrWidth}y${height}`);
    return parsedUrl.toString();
  } else {
    const param =
      parsedUrl.searchParams.get("param") ??
      parsedUrl.searchParams.get("thumbnail");
    if (!param) return null;
    const [w, h] = param.split("y").map(Number);
    return [w, h];
  }
}

/** Convert dB to linear gain. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

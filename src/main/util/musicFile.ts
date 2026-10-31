import mime from "mime";

export function isMusicFile(fileOrPath: string): boolean {
  return mime.getType(fileOrPath)?.startsWith("audio/") || false;
}

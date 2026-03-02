// eslint-disable-next-line import/no-unresolved
import { parseICO } from "icojs";
import { resolve, join } from "node:path";

export async function pngFromIco(
  icoData: ArrayBuffer | Buffer<ArrayBufferLike>
): Promise<ArrayBuffer> {
  const images = await parseICO(icoData);
  if (images.length === 0) {
    throw new Error("No images found in ICO file");
  }
  const buf = Buffer.from(images[0].buffer);
  return buf.buffer;
}

export function sanitizeRelativePath(
  base: string,
  path: string
): string | false {
  const resolvedBase = resolve(base);
  const resolvedPath = resolve(join(resolvedBase, path));
  if (!resolvedPath.startsWith(resolvedBase)) {
    return false;
  }
  return resolvedPath;
}

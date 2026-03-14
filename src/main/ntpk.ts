import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import unzipper from "unzipper";
import { pack as base } from "./folders";

const webPackFile = choosePackFile();
const files = new Map<string, unzipper.File>();

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

function createSource(file: string) {
  return {
    stream: function (offset: number, length: number) {
      offset += 100; // Skip header
      return createReadStream(file, {
        start: offset,
        end: length && offset + length,
      });
    },
    size: async function () {
      const stats = await stat(file);
      return stats.size - 100; // Exclude header
    },
  };
}

export async function readPack() {
  const zipper = await unzipper.Open.custom(createSource(webPackFile));
  for (const file of zipper.files) {
    if (file.type === "File") {
      files.set(normalize("/" + file.path), file);
    }
  }
}

export async function readFile(path: string): Promise<Buffer> {
  const file = files.get(normalize(path));
  if (!file) {
    throw new Error(`File not found in pack: ${path}`);
  }
  return await file.buffer();
}

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { normalize } from "node:path";
import unzipper from "unzipper";

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

export default class Pack {
  private path: string;
  private files: Map<string, unzipper.File> = new Map();

  constructor(path: string) {
    this.path = path;
  }

  async readPack() {
      const zipper = await unzipper.Open.custom(createSource(this.path));
      for (const file of zipper.files) {
        if (file.type === "File") {
          this.files.set(normalize("/" + file.path), file);
        }
      }
  }

  async readFile(path: string): Promise<Buffer> {
    const file = this.files.get(normalize(path));
    if (!file) {
      throw new Error(`File not found in pack: ${path}`);
    }
    return await file.buffer();
  }
}

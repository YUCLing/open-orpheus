import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

import unzipper from "unzipper";
import Pack from "./Pack";

// RSA-512 SubjectPublicKeyInfo (DER) used for web-pack signature verification
const PUBLIC_KEY = crypto.createPublicKey({
  key: Buffer.from(
    "305c300d06092a864886f70d0101010500034b003048024100" +
      "b057e5f79eaca212f43cc51de0da2349d13b0ac7de87eb52" +
      "da23096f0b1594cab08f87ff1a6a05808046a67e359b902f" +
      "8982a1ad987a83ae62246dd3b64ee6f50203010001",
    "hex"
  ),
  format: "der",
  type: "spki",
});

// Header layout (100 bytes):
//   [0..3]   version as ASCII decimal string, e.g. "0003" = version 3
//   [4..35]  32-byte ASCII hex metadata (MD5/hash of content)
//   [36..99] 64-byte RSA-512 + SHA1 signature (big-endian, PKCS#1 v1.5)
//   [100..]  plain ZIP (signed data)
async function verifySignature(file: string): Promise<boolean> {
  const fh = await open(file, "r");
  try {
    const header = Buffer.alloc(100);
    await fh.read(header, 0, 100, 0);

    if (parseInt(header.subarray(0, 4).toString("ascii"), 10) !== 3)
      return false;

    const sig = header.subarray(36, 100);

    // Stream the ZIP data through the verifier instead of slurping
    // the entire file into a single Buffer.
    const verify = crypto.createVerify("SHA1");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file, { start: 100 });
      stream.on("data", (chunk: Buffer) => verify.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    return verify.verify(PUBLIC_KEY, sig);
  } finally {
    await fh.close();
  }
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

export default class WebPack extends Pack {
  async readPack(verify = true): Promise<void> {
    if (verify && !(await verifySignature(this.path))) {
      throw new Error("Web pack signature verification failed");
    }
    const zipper = await unzipper.Open.custom(createSource(this.path));
    for (const file of zipper.files) {
      if (file.type === "File") {
        this.files[this.normalizePath(file.path)] = file;
      }
    }
    this._isLoaded = true;
  }

  async readFile(path: string): Promise<Buffer> {
    const file = this.files[this.normalizePath(path)];
    if (!file) {
      throw new Error(`File not found in pack: ${path}`);
    }
    return await file.buffer();
  }

  async getCommitHash(): Promise<string> {
    const file = await this.readFile("/pub/COMMITHASH");
    return file.toString("utf-8").trim();
  }
}

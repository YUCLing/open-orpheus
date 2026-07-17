import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";

import unzipper from "unzipper";
import Pack from "./Pack";

const ZIP_PASSWORD = "apos189nbxdftgor";

// 2048-bit RSA PUBLICKEYBLOB used for skin-pack signature verification
const PUBLIC_KEY_BLOB = Buffer.from(
  "0602000000240000525341310008000001000100" +
    "d1ee7e93d64501567ebb95e0bb39fc49020ebc893fa18ae1c6e0f4ed70a6430b" +
    "1cd103359d1cd0c8c2dfb949170d87eefea153d157ce6c1609e88a20a1537377" +
    "d9e70f5f06f12bf81ce3424a9efbdd3a68fdb36e8bbed73f51a78e9e9758c525" +
    "be0e27feabd55c21bb610073589415e01ad61bf0aebf31be648021d38a9d8541" +
    "dc45a86fd0d93da65cf4c88a6655bf9136ef66ded52b9fc52db43e088cd48c08" +
    "6569863e306831aebbb00dba7c3519b95bf2d0a584b1af0914c9fa986cfee361" +
    "28ac233fd17b39a252b696773d2ee9ae8f43a609f48eeb7c20ecf4e9af9fc753" +
    "fad79643286360902d8a8dd48c5c40d0555b8962b4e2726ad52e65e1fd9a71a8",
  "hex"
);

function blobToPem(blob: Buffer): string {
  // PUBLICKEYBLOB: [bType bVer reserved aiKeyAlg(4)] [magic(4) bitlen(4) pubexp(4)] [modulus LE]
  const bitlen = blob.readUInt32LE(12);
  const pubexp = blob.readUInt32LE(16);
  const modLen = bitlen / 8;

  // Modulus stored little-endian in the blob → reverse to big-endian for DER
  const modBE = Buffer.from(blob.subarray(20, 20 + modLen)).reverse();

  let expHex = pubexp.toString(16);
  if (expHex.length % 2) expHex = "0" + expHex;
  const expBuf = Buffer.from(expHex, "hex");

  function encodeLen(n: number): Buffer {
    if (n < 0x80) return Buffer.from([n]);
    if (n < 0x100) return Buffer.from([0x81, n]);
    return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
  }

  function encodeInt(buf: Buffer): Buffer {
    const pad = buf[0] & 0x80 ? Buffer.from([0x00]) : Buffer.alloc(0);
    const body = Buffer.concat([pad, buf]);
    return Buffer.concat([Buffer.from([0x02]), encodeLen(body.length), body]);
  }

  const modInt = encodeInt(modBE);
  const expInt = encodeInt(expBuf);
  const rsaKey = Buffer.concat([
    Buffer.from([0x30]),
    encodeLen(modInt.length + expInt.length),
    modInt,
    expInt,
  ]);

  const alg = Buffer.from("300d06092a864886f70d0101010500", "hex");
  const bits = Buffer.concat([
    Buffer.from([0x03]),
    encodeLen(rsaKey.length + 1),
    Buffer.from([0x00]),
    rsaKey,
  ]);
  const spki = Buffer.concat([
    Buffer.from([0x30]),
    encodeLen(alg.length + bits.length),
    alg,
    bits,
  ]);

  const b64 = (spki.toString("base64").match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
}

const PUBLIC_KEY_PEM = blobToPem(PUBLIC_KEY_BLOB);

/**
 * Stream-verify a skin-pack signature without loading the full ZIP into RAM.
 * The Readable returned by `createZipStream()` pipes into the verifier.
 */
async function verifySignature(
  sig: Buffer,
  createZipStream: () => Readable
): Promise<boolean> {
  // Signature is little-endian → reverse to PKCS#1 big-endian
  const sigBE = Buffer.from(sig).reverse();
  const verify = crypto.createVerify("SHA1");

  await new Promise<void>((resolve, reject) => {
    const stream = createZipStream();
    stream.on("data", (chunk: Buffer) => verify.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  return verify.verify(PUBLIC_KEY_PEM, sigBE);
}

async function parseHeader(
  file: string
): Promise<{ sigSize: number; zipOffset: number }> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(16);
    await fh.read(buf, 0, 16, 0);

    if (buf.readUInt32LE(0) !== 0x4b50544e /* "NTPK" */)
      throw new Error("Invalid .skin magic");
    if (buf.readUInt32LE(4) !== 0) throw new Error("Unsupported .skin version");

    const sigSize = buf.readUInt32LE(12);
    return { sigSize, zipOffset: 16 + sigSize };
  } finally {
    await fh.close();
  }
}

function createSource(file: string, zipOffset: number) {
  return {
    stream(offset: number, length: number) {
      const start = zipOffset + offset;
      return createReadStream(file, {
        start,
        end: length ? start + length : undefined,
      });
    },
    async size() {
      const st = await stat(file);
      return st.size - zipOffset;
    },
  };
}

export default class SkinPack extends Pack {
  private buffers: Record<string, Buffer> = Object.create(null);

  async readPack(verify = true): Promise<void> {
    const { sigSize, zipOffset } = await parseHeader(this.path);

    if (verify) {
      const fh = await open(this.path, "r");
      try {
        const sig = Buffer.alloc(sigSize);
        await fh.read(sig, 0, sigSize, 16);

        if (
          !(await verifySignature(sig, () =>
            createReadStream(this.path, { start: zipOffset })
          ))
        )
          throw new Error("Skin pack signature verification failed");
      } finally {
        await fh.close();
      }
    }

    const zipper = await unzipper.Open.custom(
      createSource(this.path, zipOffset)
    );
    for (const file of zipper.files) {
      if (file.type === "File") {
        const key = this.normalizePath(file.path);
        this.files[key] = file;
      }
    }

    this._isLoaded = true;
  }

  async readFile(path: string): Promise<Buffer> {
    path = this.normalizePath(path);
    const file = this.files[path];
    if (!file) {
      throw new Error(`File ${path} isn't found in skin pack.`);
    }
    let buf = this.buffers[path];
    if (!buf) {
      buf = await file.buffer(ZIP_PASSWORD);
      this.buffers[path] = buf;
    }
    return buf;
  }
}

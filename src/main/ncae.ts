import { Ncae, NcaeHeader, NcaeType } from "$sharedTypes/ncae";
import { inflateRaw } from "node:zlib";

// #region Binary layout

const MAGIC = new Uint8Array([0x4e, 0x43, 0x41, 0x45]); // "NCAE"

const OFF_MAGIC = 0x00;
const OFF_PAYLOAD_SIZE = 0x04;
const OFF_TYPE = 0x0e;
const OFF_EXT_COUNT = 0x10;
const OFF_EXT_DATA = 0x11;

const HEADER_SIZE = OFF_EXT_DATA; // 0x11 bytes before the extension data

// #endregion

// #region Helpers

function readUint16LE(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function readUint32LE(buf: Uint8Array, off: number): number {
  return (
    (buf[off] |
      (buf[off + 1] << 8) |
      (buf[off + 2] << 16) |
      (buf[off + 3] << 24)) >>>
    0
  );
}

function checkMagic(buf: Uint8Array): void {
  for (let i = 0; i < 4; i++) {
    if (buf[OFF_MAGIC + i] !== MAGIC[i]) {
      throw new Error("Not a valid NCAE file: bad magic");
    }
  }
}

function validateSize(
  totalLength: number,
  extCount: number,
  payloadSize: number
): void {
  const expected = HEADER_SIZE + extCount + payloadSize;
  if (totalLength !== expected) {
    throw new Error(
      `NCAE size mismatch: file is ${totalLength} bytes, ` +
        `expected ${expected} (0x11 + ${extCount} + ${payloadSize})`
    );
  }
  // Extension must be at least 5 bytes so that index 4 (the XOR key byte) exists
  if (extCount < 5) {
    throw new Error(
      `NCAE header extension count must be at least 5; got ${extCount}`
    );
  }
  // (N - 5) must be a multiple of 4 → valid values: 5, 9, 13, …
  if ((extCount - 1) & 3) {
    throw new Error(
      `NCAE header extension count must be 5, 9, 13, …; got ${extCount}`
    );
  }
}

// #endregion

// #region Stage 2 – XOR decryption of the header extension

/**
 * XOR-decrypts the extension bytes.  Byte index 4 is the XOR key itself and is
 * removed from the key material entirely — the resulting RC4 key is N−1 bytes.
 */
function xorDecryptExtension(ext: Uint8Array): Uint8Array {
  const xorKey = ext[4];
  const out = new Uint8Array(ext.length - 1);
  let w = 0;
  for (let i = 0; i < ext.length; i++) {
    if (i !== 4) {
      out[w++] = xorKey ^ ext[i];
    }
  }
  return out;
}

// #endregion

// #region Stage 3 – RC4 variant

/**
 * KSA: 256-byte state initialized with the key.
 *      Processes 4 bytes per iteration for 64 iterations (256/4).
 */
function rc4Init(key: Uint8Array): Uint8Array {
  const state = new Uint8Array(256);
  for (let i = 0; i < 256; i++) state[i] = i;

  const keyLen = key.length;
  let j = 0;
  let ki = 0;

  for (let k = 0; k < 64; k++) {
    const s0 = k * 4;
    const s1 = s0 + 1;
    const s2 = s0 + 2;
    const s3 = s0 + 3;

    j = (key[ki] + j + state[s0]) & 0xff;
    [state[s0], state[j]] = [state[j], state[s0]];

    ki = (ki + 1) % keyLen;
    j = (key[ki] + j + state[s1]) & 0xff;
    [state[s1], state[j]] = [state[j], state[s1]];

    ki = (ki + 1) % keyLen;
    j = (key[ki] + j + state[s2]) & 0xff;
    [state[s2], state[j]] = [state[j], state[s2]];

    ki = (ki + 1) % keyLen;
    j = (key[ki] + j + state[s3]) & 0xff;
    [state[s3], state[j]] = [state[j], state[s3]];

    ki = (ki + 1) % keyLen;
  }

  return state;
}

/** PRGA: generates keystream and XORs with the input. */
function rc4Crypt(state: Uint8Array, data: Uint8Array): void {
  for (let p = 0; p < data.length; p++) {
    const idx = (p + 1) & 0xff;
    const val = state[idx];
    const result = state[(state[(idx + val) & 0xff] + val) & 0xff];
    data[p] ^= result;
  }
}

// #endregion

// #region Stage 4 – Raw deflate decompression

function rawInflate(data: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    inflateRaw(data, (err, result) => {
      if (err)
        return reject(
          new Error(`NCAE deflate decompression failed`, { cause: err })
        );
      resolve(result);
    });
  });
}

// #endregion

// #region Public API

/**
 * Decode a complete NCAE buffer.
 *
 * @returns An {@link Ncae} whose `payload` is a JSON **string** for
 *          type-1 files or a `Buffer` of RIFF/WAVE data for type-2 files.
 */
export async function decodeNcae(buf: Buffer): Promise<Ncae> {
  if (buf.length < HEADER_SIZE) {
    throw new Error(
      `NCAE buffer too short: ${buf.length} bytes (need at least ${HEADER_SIZE})`
    );
  }

  const arr = new Uint8Array(buf);

  // --- Header validation ---------------------------------------------------
  checkMagic(arr);

  const payloadSize = readUint32LE(arr, OFF_PAYLOAD_SIZE);
  const type = readUint16LE(arr, OFF_TYPE);
  const extCount = arr[OFF_EXT_COUNT];

  validateSize(arr.length, extCount, payloadSize);

  // --- Stage 2: XOR-decrypt the header extension → RC4 key -----------------
  const keyStart = OFF_EXT_DATA;
  const keyEnd = keyStart + extCount;
  const rc4Key = xorDecryptExtension(arr.slice(keyStart, keyEnd));

  // --- Stage 3: RC4-decrypt the payload ------------------------------------
  const payloadStart = keyEnd;
  const payloadEnd = payloadStart + payloadSize;
  const encryptedPayload = arr.slice(payloadStart, payloadEnd);
  const rc4State = rc4Init(rc4Key);
  rc4Crypt(rc4State, encryptedPayload);

  // --- Stage 4: Raw deflate decompress -------------------------------------
  const decompressed = await rawInflate(encryptedPayload);

  // --- Stage 5: Return by type ---------------------------------------------
  const header: NcaeHeader = { payloadSize, type };
  if (type === NcaeType.Json) {
    return { header, payload: decompressed.toString("utf8") };
  }
  if (type === NcaeType.Wav) {
    return { header, payload: decompressed };
  }
  throw new Error(`Unknown NCAE type: ${type}`);
}

// #endregion

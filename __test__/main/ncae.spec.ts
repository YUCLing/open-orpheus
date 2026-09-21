import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { NcaeType } from "$sharedTypes/ncae";

import { decodeNcae } from "@main/ncae";

// Binary layout (mirrors the decoder in `src/main/ncae.ts`).
const OFF_PAYLOAD_SIZE = 0x04;
const OFF_TYPE = 0x0e;
const OFF_EXT_COUNT = 0x10;
const OFF_EXT_DATA = 0x11;
const HEADER_SIZE = OFF_EXT_DATA;

/**
 * The decoder's private RC4 variant, reproduced so fixtures can be encrypted.
 * KSA processes 4 bytes per iteration (256 / 4 = 64 iterations) and the PRGA
 * reads `state[p + 1]`, `state[(idx + val) & 0xff]`.
 */
function rc4Init(key: Uint8Array): Uint8Array {
  const state = new Uint8Array(256);
  for (let i = 0; i < 256; i++) state[i] = i;

  let j = 0;
  let ki = 0;
  for (let k = 0; k < 64; k++) {
    for (let offset = 0; offset < 4; offset++) {
      const s = k * 4 + offset;
      j = (key[ki] + j + state[s]) & 0xff;
      [state[s], state[j]] = [state[j], state[s]];
      ki = (ki + 1) % key.length;
    }
  }
  return state;
}

function rc4Crypt(state: Uint8Array, data: Uint8Array): void {
  for (let p = 0; p < data.length; p++) {
    const idx = (p + 1) & 0xff;
    const val = state[idx];
    data[p] ^= state[(state[(idx + val) & 0xff] + val) & 0xff];
  }
}

/** Build a valid NCAE file around `payload` (a JSON string or raw bytes). */
function buildNcae(options: {
  payload: string | Uint8Array;
  type: number;
  key?: Uint8Array;
  xorKey?: number;
  /** Override the declared payload size to test the size validation. */
  declaredPayloadSize?: number;
}) {
  const plaintext =
    typeof options.payload === "string"
      ? Buffer.from(options.payload, "utf8")
      : Buffer.from(options.payload);
  const deflated = deflateRawSync(plaintext);

  const key = options.key ?? Uint8Array.from([0x01, 0x02, 0x03, 0x04]);
  const xorKey = options.xorKey ?? 0x42;

  // Byte index 4 holds the XOR key itself and is excluded from the RC4 key
  // material, so the remaining N−1 bytes reconstruct the key in order.
  const ext = new Uint8Array(key.length + 1);
  ext[4] = xorKey;
  let ki = 0;
  for (let i = 0; i < ext.length; i++) {
    if (i === 4) continue;
    ext[i] = xorKey ^ key[ki++];
  }

  const encrypted = new Uint8Array(deflated);
  rc4Crypt(rc4Init(key), encrypted);

  const buf = Buffer.alloc(HEADER_SIZE + ext.length + encrypted.length);
  Buffer.from("NCAE", "latin1").copy(buf, 0);
  buf.writeUInt32LE(
    options.declaredPayloadSize ?? encrypted.length,
    OFF_PAYLOAD_SIZE
  );
  buf.writeUInt16LE(options.type, OFF_TYPE);
  buf[OFF_EXT_COUNT] = ext.length;
  Buffer.from(ext).copy(buf, OFF_EXT_DATA);
  Buffer.from(encrypted).copy(buf, OFF_EXT_DATA + ext.length);
  return buf;
}

const JSON_PAYLOAD = JSON.stringify({
  name: "360°环绕",
  params: [{ id: 1, gain: -3.5 }],
});

describe("decodeNcae", () => {
  it("decodes a JSON (type 1) payload", async () => {
    const result = await decodeNcae(
      buildNcae({ payload: JSON_PAYLOAD, type: NcaeType.Json })
    );

    expect(result.header.type).toBe(NcaeType.Json);
    expect(typeof result.payload).toBe("string");
    expect(JSON.parse(result.payload as string)).toEqual(
      JSON.parse(JSON_PAYLOAD)
    );
  });

  it("reports the declared payload size, not the decompressed one", async () => {
    const buf = buildNcae({ payload: JSON_PAYLOAD, type: NcaeType.Json });
    const declared = buf.readUInt32LE(OFF_PAYLOAD_SIZE);

    const result = await decodeNcae(buf);

    // The declared size is the encrypted (compressed) payload region.
    expect(result.header.payloadSize).toBe(declared);
    expect(declared).toBe(buf.length - HEADER_SIZE - 5);
    expect(JSON.parse(result.payload as string)).toEqual(
      JSON.parse(JSON_PAYLOAD)
    );
  });

  it("decodes a WAV (type 2) payload as bytes", async () => {
    const wav = Buffer.from("RIFF....WAVEfmt ");
    const result = await decodeNcae(
      buildNcae({ payload: wav, type: NcaeType.Wav })
    );

    expect(result.header.type).toBe(NcaeType.Wav);
    expect(Buffer.from(result.payload as Uint8Array)).toEqual(wav);
  });

  it("round-trips larger payloads that span RC4 blocks", async () => {
    const payload = "x".repeat(5000);
    const result = await decodeNcae(
      buildNcae({ payload, type: NcaeType.Json })
    );

    expect(result.payload).toBe(payload);
  });

  it("accepts any valid extension length (5, 9, 13, …)", async () => {
    for (const key of [
      Uint8Array.from([1, 2, 3, 4]),
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
      Uint8Array.from(Array.from({ length: 12 }, (_, i) => i + 1)),
    ]) {
      const result = await decodeNcae(
        buildNcae({ payload: JSON_PAYLOAD, type: NcaeType.Json, key })
      );
      expect(result.payload).toBe(JSON_PAYLOAD);
    }
  });

  it("works with a zero XOR key", async () => {
    const result = await decodeNcae(
      buildNcae({ payload: JSON_PAYLOAD, type: NcaeType.Json, xorKey: 0x00 })
    );

    expect(result.payload).toBe(JSON_PAYLOAD);
  });

  it("rejects buffers shorter than the header", async () => {
    await expect(decodeNcae(Buffer.alloc(16))).rejects.toThrow(
      /NCAE buffer too short/
    );
    await expect(decodeNcae(Buffer.alloc(0))).rejects.toThrow(
      /NCAE buffer too short/
    );
  });

  it("rejects a bad magic", async () => {
    const buf = buildNcae({ payload: JSON_PAYLOAD, type: NcaeType.Json });
    buf.write("NOPE", 0, "latin1");

    await expect(decodeNcae(buf)).rejects.toThrow(/bad magic/);
  });

  it("rejects a size mismatch", async () => {
    const buf = buildNcae({
      payload: JSON_PAYLOAD,
      type: NcaeType.Json,
      declaredPayloadSize: 1,
    });

    await expect(decodeNcae(buf)).rejects.toThrow(/size mismatch/);
  });

  it("rejects an extension count below 5", async () => {
    const payload = Buffer.from("short");
    const buf = Buffer.alloc(HEADER_SIZE + 4 + payload.length);
    Buffer.from("NCAE", "latin1").copy(buf, 0);
    buf.writeUInt32LE(payload.length, OFF_PAYLOAD_SIZE);
    buf.writeUInt16LE(NcaeType.Json, OFF_TYPE);
    buf[OFF_EXT_COUNT] = 4;

    await expect(decodeNcae(buf)).rejects.toThrow(
      /extension count must be at least 5/
    );
  });

  it("rejects extension counts that are not 5, 9, 13, …", async () => {
    // A 5-byte RC4 key yields extCount 6, which is not 4k + 1.
    const buf = buildNcae({
      payload: JSON_PAYLOAD,
      type: NcaeType.Json,
      key: Uint8Array.from([1, 2, 3, 4, 5]),
    });

    await expect(decodeNcae(buf)).rejects.toThrow(/must be 5, 9, 13/);
  });

  it("rejects an unknown type", async () => {
    const buf = buildNcae({ payload: JSON_PAYLOAD, type: 3 });

    await expect(decodeNcae(buf)).rejects.toThrow(/Unknown NCAE type: 3/);
  });

  it("rejects a payload that is not deflate data", async () => {
    const buf = buildNcae({
      payload: "z".repeat(200),
      type: NcaeType.Json,
    });
    // Overwrite the encrypted payload with noise: RC4 turns it into bytes that
    // cannot be raw-inflated.
    buf.fill(0xff, OFF_EXT_DATA + 5);

    await expect(decodeNcae(buf)).rejects.toThrow(
      /deflate decompression failed/
    );
  });
});

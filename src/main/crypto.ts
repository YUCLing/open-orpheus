import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

// XOR key used for anonymous-ID encoding
export const ID_XOR_KEY_1 = Buffer.from("3go8&$8*3*3h0k(2)2");

// AES-128 key used for data encryption/decryption
export const DATA_AES_KEY = Buffer.from("(b)$@.a!mr+-<?`x");

// AES-128 key used by serialKey
export const SERIAL_AES_KEY = Buffer.from(")(13daqP@ssw0rd~");

// AES-128 key used by ID3 comments
export const ID3_AES_KEY = Buffer.from("#14ljk_!\\]&0U<'(");

// AES-128 key for EAPI request encryption
export const EAPI_KEY = Buffer.from("e82ckenh8dichen8");

// Separator used to delimit the signed EAPI payload
export const EAPI_SEPARATOR = "-36cd479b6b5-";

// #region Channel Crypto Algorithms

/**
 * Encodes an anonymous user ID.
 *
 * Algorithm:
 *   1. XOR each byte of the UTF-8 encoded ID against the repeating key
 *   2. MD5-hash the XORed bytes  →  16 raw bytes
 *   3. Base64-encode the raw MD5 digest
 */
export function encodeAnonymousId(anonymousId: string): string {
  const input = Buffer.from(anonymousId, "utf8");

  // Step 1 — XOR each byte against the cycling key
  const xored = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) {
    xored[i] = input[i] ^ ID_XOR_KEY_1[i % ID_XOR_KEY_1.length];
  }

  // Step 2 — MD5 hash the XORed bytes  →  16 raw bytes
  const digest = createHash("md5").update(xored).digest();

  // Step 3 — Base64-encode the raw digest
  return digest.toString("base64");
}

/**
 * Encrypts plaintext using AES-128-ECB + double Base64.
 *
 * Pipeline:
 *   plaintext → PKCS#7 pad → AES-128-ECB → Base64 #1 → Base64 #2 (optional)
 */
export function enData(
  plaintext: string,
  key = DATA_AES_KEY,
  doubleBase64 = true
) {
  if (!Buffer.isBuffer(key) || key.length !== 0x10) {
    console.error("Error: enData: AES_set_encrypt_key error!");
    return null;
  }
  // No IV in ECB mode
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);

  // Base64 #1
  const base64Once = encrypted.toString("base64");

  if (!doubleBase64) return base64Once;

  // Base64 #2
  return Buffer.from(base64Once).toString("base64");
}

/**
 * Decrypts a double-Base64-encoded or buffer AES-128-ECB ciphertext.
 *
 * Pipeline (reversed):
 *   Base64 #2 decode → Base64 #1 decode → AES-128-ECB decrypt → PKCS#7 unpad
 */
export function deData(
  bufOr2Base64: string | Buffer,
  key = DATA_AES_KEY,
  doubleBase64 = true
): Buffer | null {
  if (!Buffer.isBuffer(key) || key.length !== 0x10) {
    console.error("Error: deData: invalid key length, expected 16 bytes");
    return null;
  }

  // Reverse Base64 #2
  let ciphertext: Buffer =
    typeof bufOr2Base64 === "string"
      ? Buffer.from(bufOr2Base64, "base64")
      : bufOr2Base64;

  // Reverse Base64 #1
  if (doubleBase64)
    ciphertext = Buffer.from(ciphertext.toString("utf8"), "base64");

  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    console.error("Error: deData: ciphertext length is not a multiple of 16");
    return null;
  }

  // Reverse AES-128-ECB encryption
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted;
}

/**
 * Encrypts an EAPI request for /eapi/* endpoints.
 *
 * Algorithm:
 *   1. Build signing message:  `nobody{path}use{body}md5forencrypt`
 *   2. MD5-hash it             → 32-char lowercase hex digest
 *   3. Build plaintext:        `{path}-36cd479b6b5-{body}-36cd479b6b5-{digest}`
 *   4. AES-128-ECB encrypt with PKCS#7 auto-padding
 *   5. HEX encode, uppercase   → final `params` string
 */
export function serialData(apiPath: string, body: string | object): string {
  const text = typeof body === "object" ? JSON.stringify(body) : body;

  // Step 1 — signing message
  const message = `nobody${apiPath}use${text}md5forencrypt`;

  // Step 2 — MD5 sign
  const digest = createHash("md5").update(message).digest("hex");

  // Step 3 — build plaintext payload
  const plaintext = `${apiPath}${EAPI_SEPARATOR}${text}${EAPI_SEPARATOR}${digest}`;

  // Step 4 — AES-128-ECB encrypt
  // No IV in ECB mode
  const cipher = createCipheriv("aes-128-ecb", EAPI_KEY, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);

  // Step 5 — uppercase HEX
  return encrypted.toString("hex").toUpperCase();
}

/**
 * Decrypts serialData back to plaintext.
 */
export function deserialData(hexParams: string | ArrayBuffer): string {
  const decipher = createDecipheriv("aes-128-ecb", EAPI_KEY, null);
  decipher.setAutoPadding(true);
  const plaintext = Buffer.concat([
    decipher.update(
      typeof hexParams === "string"
        ? Buffer.from(hexParams, "hex")
        : Buffer.from(hexParams)
    ),
    decipher.final(),
  ]).toString("utf8");

  return plaintext;
}

// #endregion

// #region Generic Crypto Algorithms

// #region ChaCha20
const CHACHA_CONSTANT = new Uint32Array([
  0x61707865, 0x3320646e, 0x79622d32, 0x6b206574,
]);

function rotl(v: number, b: number): number {
  return ((v << b) | (v >>> (32 - b))) >>> 0;
}

function quarterRound(
  s: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number
): void {
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotl(s[b] ^ s[c], 7);
}

function chacha20Block(
  key: Uint32Array,
  counter: number,
  nonce: Uint32Array
): Uint8Array {
  const state = new Uint32Array(16);
  state.set(CHACHA_CONSTANT, 0); // words 0-3
  state.set(key, 4); // words 4-11
  state[12] = counter >>> 0; // word 12: block counter
  state.set(nonce, 13); // words 13-15

  const working = new Uint32Array(state);
  for (let i = 0; i < 10; i++) {
    // Column round
    quarterRound(working, 0, 4, 8, 12);
    quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14);
    quarterRound(working, 3, 7, 11, 15);
    // Diagonal round
    quarterRound(working, 0, 5, 10, 15);
    quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13);
    quarterRound(working, 3, 4, 9, 14);
  }

  for (let i = 0; i < 16; i++) {
    working[i] = (working[i] + state[i]) >>> 0;
  }

  return new Uint8Array(working.buffer);
}

export function chacha20Encrypt(
  key: Buffer,
  nonce12: Buffer,
  initialCounter: number,
  plaintext: Buffer
): Buffer {
  const keyWords = new Uint32Array(
    key.buffer.slice(key.byteOffset, key.byteOffset + 32)
  );
  const nonceWords = new Uint32Array(
    nonce12.buffer.slice(nonce12.byteOffset, nonce12.byteOffset + 12)
  );

  const out = Buffer.alloc(plaintext.length);
  let counter = initialCounter;
  let offset = 0;

  while (offset < plaintext.length) {
    const keystream = chacha20Block(keyWords, counter, nonceWords);
    const chunkLen = Math.min(64, plaintext.length - offset);
    for (let i = 0; i < chunkLen; i++) {
      out[offset + i] = plaintext[offset + i] ^ keystream[i];
    }
    offset += chunkLen;
    counter++;
  }

  return out;
}

// #endregion

// #region Raw RSA

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function bufToBigInt(buf: Buffer): bigint {
  return BigInt("0x" + buf.toString("hex"));
}

function bigIntToBuf(value: bigint, byteLen: number): Buffer {
  const hex = value.toString(16).padStart(byteLen * 2, "0");
  return Buffer.from(hex, "hex");
}

export function rawRsaEncrypt(
  plaintext: Buffer,
  exponent: bigint,
  modulus: bigint
): Buffer {
  const m = bufToBigInt(plaintext);
  // Caller guarantees m < modulus
  const c = modPow(m, exponent, modulus);
  return bigIntToBuf(c, 32);
}

// #endregion

// #endregion

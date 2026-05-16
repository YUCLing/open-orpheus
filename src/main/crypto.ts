import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

import parentLogger from "./logger";

const logger = parentLogger.child({ name: "crypto" });

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
    logger.error({ algo: "enData" }, "Invalid input key: %s", key);
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
    logger.error({ algo: "deData" }, "Invalid input key: %s", key);
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
    logger.error(
      { algo: "deData", ciphertext },
      "Ciphertext length is not a multiple of 16"
    );
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

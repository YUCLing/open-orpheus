import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

// XOR key extracted from cloudmusic.dll
export const ID_XOR_KEY_1 = Buffer.from("3go8&$8*3*3h0k(2)2");

// AES-128 key extracted from binary at DAT_181d754a8
export const DATA_AES_KEY = Buffer.from("(b)$@.a!mr+-<?`x");

// AES-128 key extracted from binary in FUN_1802f0ce0, used by serialKey
export const SERIAL_AES_KEY = Buffer.from(")(13daqP@ssw0rd~");

// AES-128 key for EAPI — hardcoded in cloudmusic.dll
export const EAPI_KEY = Buffer.from("e82ckenh8dichen8");

// Separator used to delimit the signed payload — also hardcoded in the binary
export const EAPI_SEPARATOR = "-36cd479b6b5-";

/**
 * Replicates encodeAnonymousId() from cloudmusic.dll.
 *
 * Algorithm:
 *   1. XOR each byte of the UTF-8 encoded ID against the repeating key "3go8&$8*3*3h0k(2)2"
 *   2. MD5-hash the XORed bytes  →  16 raw bytes
 *   3. Base64-encode the raw MD5 digest
 */
export function encodeAnonymousId(anonymousId: string): string {
  const input = Buffer.from(anonymousId, "utf8");

  // Step 1 — XOR each byte against the cycling key
  // Mirrors: bytearray([c ^ ID_XOR_KEY_1[idx % len(ID_XOR_KEY_1)] for idx, c in enumerate(some_id.encode())])
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
 * Mirrors enData() + its caller FUN_180e0a800 in the binary.
 *
 * Pipeline:
 *   plaintext → PKCS#7 pad → AES-128-ECB → Base64 #1 → Base64 #2 (optional due to serialKey)
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

  // Base64 #1 — mirrors FUN_1802ef230 inside addid3content()
  const base64Once = encrypted.toString("base64");

  if (!doubleBase64) return base64Once;

  // Base64 #2 — mirrors FUN_180503a00 in the caller FUN_180e0a800
  return Buffer.from(base64Once).toString("base64");
}

/**
 * Decrypts a double-Base64-encoded or buffer AES-128-ECB ciphertext.
 * Exact reverse of addid3content(), unwinding each step in reverse order.
 *
 * Pipeline (reversed):
 *   Base64 #2 decode → Base64 #1 decode → AES-128-ECB decrypt → PKCS#7 unpad
 */
export function deData(bufOr2Base64: string | Buffer, key = DATA_AES_KEY) {
  if (!Buffer.isBuffer(key) || key.length !== 0x10) {
    console.error("Error: deData: invalid key length, expected 16 bytes");
    return null;
  }

  // Reverse Base64 #2 — undo FUN_180503a00 in caller FUN_180e0a800
  const base64Once =
    typeof bufOr2Base64 === "string"
      ? Buffer.from(bufOr2Base64, "base64").toString("utf8")
      : bufOr2Base64.toString("utf8");

  // Reverse Base64 #1 — undo FUN_1802ef230 inside addid3content()
  const ciphertext = Buffer.from(base64Once, "base64");

  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    console.error("Error: deData: ciphertext length is not a multiple of 16");
    return null;
  }

  // Reverse AES-128-ECB encryption — undo AES_encrypt() loop
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted;
}

/**
 * Replicates the `serialData` channel function (FUN_180e0d3a0) from cloudmusic.dll.
 *
 * This is the EAPI request encryption used for all /eapi/* endpoints.
 * Takes the same [apiPath, jsonBody] tuple that the dispatcher passes in param_4.
 *
 * Algorithm:
 *   1. Build signing message:  `nobody{path}use{body}md5forencrypt`
 *   2. MD5-hash it             → 32-char lowercase hex digest
 *   3. Build plaintext:        `{path}-36cd479b6b5-{body}-36cd479b6b5-{digest}`
 *   4. AES-128-ECB encrypt     (key: "e82ckenh8dichen8", PKCS#7 auto-padding)
 *   5. HEX encode, uppercase   → final `params` string
 */
export function serialData(apiPath: string, body: string | object): string {
  const text = typeof body === "object" ? JSON.stringify(body) : body;

  // Step 1 — signing message (the "message" in FUN_180e0d3a0)
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

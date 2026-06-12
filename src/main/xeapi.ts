import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { data } from "./folders";

const STATIC_KEY_BASE64 = "hw7WBGc5HWCZzhBM50P3pDvtn/RzxDy+FW+wygIErn4=";
const SIGN_KEY =
  "YN6+QFyG6D3rc3J1VT6sqwaPKE+GdwxtDweGmEPklcgrEohaE60m4Y/TtI4R/vVi17JUwwCIQF0Q2FXFmMlGrg==";
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex"
);
const PUBLIC_KEY_CACHE_PATH = resolve(data, "Aegis", "pubkey");
const DEFAULT_DYNAMIC_KEY_INTERVAL_MINUTE = 5;
const LOCAL_ENCRYPT_FAILURE_THRESHOLD = 1;
const PUBLIC_KEY_UPDATE_FAILURE_THRESHOLD = 3;

export const enum AegisEncryptState {
  Normal = 0,
  LocalFallback = 1,
  GlobalFallback = 2,
  ClientFallback = 3,
}

export type AegisInitConfig = {
  aegisUpdateIntervalMinute?: number;
  updateIntervalMinute?: number;
};

export type AegisPublicKeyRequest = {
  currentKeyVersion: string;
  requestType: "active" | "passive";
  signature: string;
  timestamp: string;
  nonce: string;
};

type PublicKeyState = {
  publicKey: string;
  version: string;
  sk: string;
  nextUpdateTime: number;
};

type AegisPublicKeyResponse = {
  code?: number;
  data?: {
    encryptedData?: string;
    signature?: string;
    timestamp?: string | number;
  };
};

export type AegisCallbacks = {
  onEncryptStateChange: (state: AegisEncryptState, reason: string) => void;
  onRequestPublicKey: (request: AegisPublicKeyRequest) => void;
};

export class XeapiAegis {
  private readonly staticKey = Buffer.from(STATIC_KEY_BASE64, "base64");
  private readonly publicKeyCachePath: string;
  private publicKey: PublicKeyState | null = null;
  private dynamicKey = randomBytes(16);
  private dynamicKeyCreatedAt = Date.now();
  private dynamicKeyIntervalMinute = DEFAULT_DYNAMIC_KEY_INTERVAL_MINUTE;
  private sessionId = "";
  private sessionKey = "";
  private state = AegisEncryptState.LocalFallback;
  private callbacks: AegisCallbacks | null = null;
  private pendingPublicKeyNonce = "";
  private localEncryptFailCount = 0;
  private publicKeyUpdateFailCount = 0;

  constructor(publicKeyCachePath = PUBLIC_KEY_CACHE_PATH) {
    this.publicKeyCachePath = publicKeyCachePath;
  }

  init(config: AegisInitConfig, callbacks: AegisCallbacks) {
    this.callbacks = callbacks;
    const updateIntervalMinute =
      config.aegisUpdateIntervalMinute ?? config.updateIntervalMinute;
    if (updateIntervalMinute && updateIntervalMinute > 0) {
      this.dynamicKeyIntervalMinute = updateIntervalMinute;
    }

    this.loadCachedPublicKey();
    this.updateState(
      this.publicKey
        ? AegisEncryptState.Normal
        : AegisEncryptState.LocalFallback,
      this.publicKey ? "cached_public_key" : "missing_public_key"
    );
    this.requestPublicKey("active");
    return { errorCode: 0 };
  }

  setSession(sessionId = "", sessionKey = "") {
    this.sessionId = sessionId;
    this.sessionKey = sessionKey;
  }

  encrypt(body: string) {
    try {
      if (!this.publicKey) {
        this.requestPublicKey("active");
        throw new Error("Aegis public key is missing");
      }

      const businessKey = this.getBusinessKey();
      const b = this.encryptBusinessData(body, businessKey);
      const s = this.encryptDynamicKey(businessKey);
      const r = aesEcbEncrypt(
        this.staticKey,
        Buffer.from(`${this.publicKey.version}|${this.sessionId}`, "utf8")
      );

      this.localEncryptFailCount = 0;
      return [
        `B=${urlEncode(b.toString("base64"))}`,
        `S=${urlEncode(s.toString("base64"))}`,
        `R=${urlEncode(r.toString("base64"))}`,
      ].join("&");
    } catch (error) {
      this.recordLocalEncryptFailure(error);
      throw error;
    }
  }

  updatePublicKeyResponse(responseText: string) {
    let response: AegisPublicKeyResponse;
    try {
      response = JSON.parse(responseText) as AegisPublicKeyResponse;
    } catch {
      this.recordPublicKeyUpdateFailure("invalid_public_key_response_json");
      return false;
    }

    if (response.code && response.code !== 200) {
      if (response.code !== 429) {
        this.recordPublicKeyUpdateFailure(
          `public_key_response_code_${response.code}`
        );
      }
      return false;
    }

    const { encryptedData, signature, timestamp } = response.data ?? {};
    if (!encryptedData || !signature || timestamp === undefined) {
      this.recordPublicKeyUpdateFailure("missing_public_key_response_data");
      return false;
    }

    const timestampText = String(timestamp);
    const expectedSignature = hmacSha256Base64(
      SIGN_KEY,
      timestampText + this.pendingPublicKeyNonce
    );
    if (signature !== expectedSignature) {
      this.recordPublicKeyUpdateFailure(
        "invalid_public_key_response_signature"
      );
      return false;
    }

    let plaintext: string;
    let nextPublicKey: PublicKeyState;
    try {
      plaintext = aesEcbDecrypt(
        this.staticKey,
        Buffer.from(encryptedData, "base64")
      ).toString("utf8");
      nextPublicKey = JSON.parse(plaintext) as PublicKeyState;
    } catch {
      this.recordPublicKeyUpdateFailure("invalid_public_key_encrypted_data");
      return false;
    }

    if (!isPublicKeyState(nextPublicKey)) {
      this.recordPublicKeyUpdateFailure("invalid_public_key_state");
      return false;
    }

    this.publicKey = nextPublicKey;
    this.publicKeyUpdateFailCount = 0;
    this.saveCachedPublicKey(plaintext);
    this.updateState(AegisEncryptState.Normal, "public_key_updated");
    return true;
  }

  private requestPublicKey(requestType: "active" | "passive") {
    const timestamp = String(Date.now());
    const nonce = makeNonce();
    this.pendingPublicKeyNonce = nonce;
    this.callbacks?.onRequestPublicKey({
      currentKeyVersion: this.publicKey?.version ?? "",
      requestType,
      signature: hmacSha256Base64(SIGN_KEY, timestamp + nonce),
      timestamp,
      nonce,
    });
  }

  private updateState(state: AegisEncryptState, reason: string) {
    if (this.state === state && reason !== "public_key_updated") return;
    this.state = state;
    this.callbacks?.onEncryptStateChange(state, reason);
  }

  private recordLocalEncryptFailure(error: unknown) {
    this.localEncryptFailCount++;
    if (this.localEncryptFailCount < LOCAL_ENCRYPT_FAILURE_THRESHOLD) return;

    this.updateState(
      this.publicKey
        ? AegisEncryptState.ClientFallback
        : AegisEncryptState.LocalFallback,
      `local_encrypt_failed:${getErrorMessage(error)}`
    );
  }

  private recordPublicKeyUpdateFailure(reason: string) {
    this.publicKeyUpdateFailCount++;
    if (!this.publicKey) {
      this.updateState(AegisEncryptState.LocalFallback, reason);
      return;
    }
    if (this.publicKeyUpdateFailCount < PUBLIC_KEY_UPDATE_FAILURE_THRESHOLD) {
      return;
    }
    this.updateState(AegisEncryptState.ClientFallback, reason);
  }

  private getBusinessKey() {
    if (this.sessionId && this.sessionKey) {
      return Buffer.from(this.sessionKey, "utf8");
    }

    const ageMs = Date.now() - this.dynamicKeyCreatedAt;
    if (ageMs >= this.dynamicKeyIntervalMinute * 60_000) {
      this.dynamicKey = randomBytes(16);
      this.dynamicKeyCreatedAt = Date.now();
    }
    return this.dynamicKey;
  }

  private encryptBusinessData(body: string, businessKey: Buffer) {
    const staticCiphertext = aesEcbEncrypt(
      this.staticKey,
      Buffer.from(body, "utf8")
    );
    const transformed = transformBusinessData(staticCiphertext);
    return aesEcbEncrypt(businessKey, transformed);
  }

  private encryptDynamicKey(businessKey: Buffer) {
    if (!this.publicKey) throw new Error("Aegis public key is missing");

    const plaintext = Buffer.from(
      `${businessKey.toString("base64")}|pc|${this.publicKey.sk}`,
      "utf8"
    );
    const serverPublicKey = Buffer.from(this.publicKey.publicKey, "base64");
    if (serverPublicKey.byteLength !== 32) {
      throw new Error("Invalid Aegis public key length");
    }

    const peerPublicKey = createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, serverPublicKey]),
      format: "der",
      type: "spki",
    });
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const ephemeralPublicKey = exportRawX25519PublicKey(publicKey);
    const sharedSecret = diffieHellman({
      privateKey,
      publicKey: peerPublicKey,
    });
    const key = Buffer.from(
      hkdfSync("sha256", sharedSecret, Buffer.alloc(32), ephemeralPublicKey, 16)
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-128-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([ephemeralPublicKey, iv, ciphertext, tag]);
  }

  private loadCachedPublicKey() {
    try {
      const cache = readFileSync(this.publicKeyCachePath, "utf8");
      const decoded = Buffer.from(cache, "base64").toString("utf8");
      const publicKey = JSON.parse(decoded) as PublicKeyState;
      if (isPublicKeyState(publicKey)) {
        this.publicKey = publicKey;
      }
    } catch {
      this.publicKey = null;
    }
  }

  private saveCachedPublicKey(plaintext: string) {
    mkdirSync(dirname(this.publicKeyCachePath), { recursive: true });
    writeFileSync(
      this.publicKeyCachePath,
      Buffer.from(plaintext, "utf8").toString("base64")
    );
  }
}

function transformBusinessData(ciphertext: Buffer) {
  const random = randomBytes(16);
  const xored = Buffer.alloc(ciphertext.byteLength);
  for (let i = 0; i < ciphertext.byteLength; i++) {
    xored[i] = ciphertext[i] ^ random[i % random.byteLength];
  }

  const base64 = xored.toString("base64");
  const offset = base64.length ? (random[0] & 0x0f) % base64.length : 0;
  const rotated = base64.slice(offset) + base64.slice(0, offset);
  return Buffer.concat([random, Buffer.from(rotated, "utf8")]);
}

function aesEcbEncrypt(key: Buffer, plaintext: Buffer) {
  const cipher = createCipheriv(aesEcbCipherName(key), key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbDecrypt(key: Buffer, ciphertext: Buffer) {
  const decipher = createDecipheriv(aesEcbCipherName(key), key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbCipherName(key: Buffer) {
  if (key.byteLength === 16) return "aes-128-ecb";
  if (key.byteLength === 24) return "aes-192-ecb";
  if (key.byteLength === 32) return "aes-256-ecb";
  throw new Error(`Invalid AES key length: ${key.byteLength}`);
}

function hmacSha256Base64(key: string | Buffer, message: string) {
  return createHmac("sha256", key).update(message, "utf8").digest("base64");
}

function makeNonce() {
  const values: string[] = [];
  for (let i = 0; i < 16; i++) {
    values.push(String(randomBytes(4).readInt32LE()));
  }
  return values.join("");
}

function urlEncode(value: string) {
  return value.replace(
    /[^A-Za-z0-9\-._~]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function exportRawX25519PublicKey(key: KeyObject) {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(-32);
}

export function importRawX25519PrivateKey(rawKey: Buffer) {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, rawKey]),
    format: "der",
    type: "pkcs8",
  });
}

function isPublicKeyState(value: unknown): value is PublicKeyState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PublicKeyState>;
  return (
    typeof state.publicKey === "string" &&
    typeof state.version === "string" &&
    typeof state.sk === "string" &&
    typeof state.nextUpdateTime === "number"
  );
}

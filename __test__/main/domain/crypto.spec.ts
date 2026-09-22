import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  chacha20Encrypt,
  deData,
  deserialData,
  encodeAnonymousId,
  enData,
  EAPI_SEPARATOR,
  rawRsaEncrypt,
  serialData,
} from "@main/domain/crypto";
import { installLoggerStub } from "../../helpers/globals";

beforeAll(() => {
  installLoggerStub();
});

describe("encodeAnonymousId", () => {
  it("produces a base64 MD5 digest", () => {
    // 16 bytes of MD5 → 24 base64 characters including padding.
    const encoded = encodeAnonymousId("test");
    expect(encoded).toHaveLength(24);
    expect(Buffer.from(encoded, "base64")).toHaveLength(16);
  });

  it("matches the XOR + MD5 + base64 pipeline", () => {
    // Reference values produced by an independent implementation of the
    // documented algorithm (XOR with `3go8&$8*3*3h0k(2)2`, MD5, base64).
    expect(encodeAnonymousId("test")).toBe("+j1v8jOoHswne3BAqm/0Fg==");
    expect(encodeAnonymousId("12345")).toBe("SOJgz/ObU1tgyRJptBgDTA==");
  });

  it("hashes the empty string to the MD5 of the empty digest", () => {
    expect(encodeAnonymousId("")).toBe("1B2M2Y8AsgTpgAmY7PhCfg==");
  });

  it("is deterministic and input sensitive", () => {
    expect(encodeAnonymousId("abc")).toBe(encodeAnonymousId("abc"));
    expect(encodeAnonymousId("abc")).not.toBe(encodeAnonymousId("abd"));
  });

  it("handles multi-byte characters", () => {
    expect(
      Buffer.from(encodeAnonymousId("不完美人生指南"), "base64")
    ).toHaveLength(16);
  });
});

describe("enData / deData", () => {
  it("round trips plaintext through the double base64 pipeline", () => {
    const ciphertext = enData("hello orpheus");
    expect(ciphertext).not.toBeNull();
    expect(typeof ciphertext).toBe("string");

    const decrypted = deData(ciphertext!);
    expect(decrypted?.toString("utf8")).toBe("hello orpheus");
  });

  it("round trips plaintext with a single base64 layer", () => {
    const ciphertext = enData("single layer", undefined, false);
    const decrypted = deData(ciphertext!, undefined, false);
    expect(decrypted?.toString("utf8")).toBe("single layer");
  });

  it("accepts a raw ciphertext buffer", () => {
    // `enData(..., false)` yields base64 of the raw AES-ECB ciphertext.
    const single = enData("buffer in", undefined, false)!;
    const raw = Buffer.from(single, "base64");

    expect(deData(raw, undefined, false)?.toString("utf8")).toBe("buffer in");
    // The double-base64 variant may also receive the first layer as a buffer.
    expect(
      deData(Buffer.from(single, "utf8"), undefined, true)?.toString("utf8")
    ).toBe("buffer in");
  });

  it("encrypts to a multiple of the AES block size", () => {
    const ciphertext = enData("0123456789", undefined, false)!;
    expect(Buffer.from(ciphertext, "base64").length % 16).toBe(0);
  });

  it("handles unicode and empty payloads", () => {
    for (const text of ["不完美人生指南", "", "-36cd479b6b5-"]) {
      const decrypted = deData(enData(text)!, undefined, true);
      expect(decrypted?.toString("utf8")).toBe(text);
    }
  });

  it("rejects a key that is not 16 bytes", () => {
    const logger = installLoggerStub();
    expect(enData("x", Buffer.alloc(8))).toBeNull();
    expect(deData("x", Buffer.alloc(32))).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("returns null for a ciphertext whose length is not block aligned", () => {
    const logger = installLoggerStub();
    expect(deData(Buffer.alloc(5), undefined, false)).toBeNull();
    expect(deData(Buffer.alloc(17), undefined, false)).toBeNull();
    expect(deData(Buffer.alloc(0))).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(3);
  });
});

describe("serialData / deserialData", () => {
  it("round trips a request body", () => {
    const body = { ids: "[1]", level: "standard" };
    const params = serialData("/api/v3/song/detail", body);

    const plaintext = deserialData(params);
    const digest = createHash("md5")
      .update(
        `nobody/api/v3/song/detailuse${JSON.stringify(body)}md5forencrypt`
      )
      .digest("hex");

    expect(plaintext).toBe(
      `/api/v3/song/detail${EAPI_SEPARATOR}${JSON.stringify(body)}${EAPI_SEPARATOR}${digest}`
    );
  });

  it("accepts a raw string body", () => {
    const plaintext = deserialData(serialData("/api/x", "raw=1"));
    expect(plaintext).toContain(`/api/x${EAPI_SEPARATOR}raw=1`);
  });

  it("emits uppercase hex", () => {
    const params = serialData("/api/x", "y");
    expect(params).toMatch(/^[0-9A-F]+$/);
    expect(params).toBe(params.toUpperCase());
    expect(params.length % 32).toBe(0);
  });

  it("decrypts an ArrayBuffer payload", () => {
    const params = serialData("/api/x", "y");
    const bytes = Buffer.from(params, "hex");
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;

    expect(deserialData(arrayBuffer)).toContain("/api/x");
  });
});

describe("chacha20Encrypt", () => {
  // RFC 8439 §2.4.2 test vector.
  const RFC_KEY = Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex"
  );
  const RFC_NONCE = Buffer.from("000000000000004a00000000", "hex");
  const RFC_PLAINTEXT = Buffer.from(
    "Ladies and Gentlemen of the class of '99: If I could offer you only " +
      "one tip for the future, sunscreen would be it.",
    "utf8"
  );
  const RFC_CIPHERTEXT = Buffer.from(
    "6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b" +
      "f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8" +
      "07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736" +
      "5af90bbf74a35be6b40b8eedf2785e42874d",
    "hex"
  );

  it("matches the RFC 8439 test vector", () => {
    expect(
      chacha20Encrypt(RFC_KEY, RFC_NONCE, 1, RFC_PLAINTEXT).toString("hex")
    ).toBe(RFC_CIPHERTEXT.toString("hex"));
  });

  it("is its own inverse", () => {
    const encrypted = chacha20Encrypt(RFC_KEY, RFC_NONCE, 1, RFC_PLAINTEXT);
    const decrypted = chacha20Encrypt(RFC_KEY, RFC_NONCE, 1, encrypted);
    expect(decrypted.toString("utf8")).toBe(RFC_PLAINTEXT.toString("utf8"));
  });

  it("keeps the plaintext length, including partial blocks", () => {
    for (const length of [0, 1, 63, 64, 65, 200]) {
      const plaintext = Buffer.alloc(length, 0x41);
      expect(chacha20Encrypt(RFC_KEY, RFC_NONCE, 0, plaintext)).toHaveLength(
        length
      );
    }
  });

  it("produces the same keystream for the same counter", () => {
    const plaintext = Buffer.alloc(64);
    expect(
      chacha20Encrypt(RFC_KEY, RFC_NONCE, 7, plaintext).toString("hex")
    ).toBe(chacha20Encrypt(RFC_KEY, RFC_NONCE, 7, plaintext).toString("hex"));
    expect(
      chacha20Encrypt(RFC_KEY, RFC_NONCE, 8, plaintext).toString("hex")
    ).not.toBe(
      chacha20Encrypt(RFC_KEY, RFC_NONCE, 7, plaintext).toString("hex")
    );
  });
});

describe("rawRsaEncrypt", () => {
  it("computes modPow and pads the result to 32 bytes", () => {
    // 2^17 mod 3233 = 1752 (0x06d8)
    const result = rawRsaEncrypt(Buffer.from([2]), 17n, 3233n);

    expect(result).toHaveLength(32);
    expect(result.readUInt32BE(28)).toBe(1752);
  });

  it("keeps 32-byte outputs for larger plaintexts", () => {
    const plaintext = Buffer.alloc(32);
    plaintext[31] = 3;
    const modulus = BigInt("0x" + "f0".repeat(32));
    const result = rawRsaEncrypt(plaintext, 65537n, modulus);

    expect(result).toHaveLength(32);
    expect(result.equals(plaintext)).toBe(false);
  });

  it("maps a zero plaintext to zero", () => {
    expect(
      rawRsaEncrypt(Buffer.alloc(1), 3n, 3233n).every((b) => b === 0)
    ).toBe(true);
  });
});

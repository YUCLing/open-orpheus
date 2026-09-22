import { createDecipheriv } from "node:crypto";
import { inflateSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: vi.fn() }));

import { GenerateFP } from "@main/domain/afp";

const VERSION = "hyai_1.2.0_client_1.0.0";
const SAMPLE_RATE = 8000;
const WINDOW_SIZE = 2048;

/** Decrypt + decompress the fingerprint blob produced by `GenerateFP`. */
function decodeFingerprint(blob: string): Buffer {
  const decipher = createDecipheriv(
    "aes-128-ecb",
    Buffer.from("4B97221F27F02907", "ascii"),
    null
  );
  decipher.setAutoPadding(true);
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(blob, "base64")),
    decipher.final(),
  ]);
  return inflateSync(compressed);
}

/** Amplitude of a sine tone, as Float32 PCM at 8 kHz. */
function tone(hz: number, seconds: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * amplitude;
  }
  return samples;
}

describe("GenerateFP", () => {
  it("returns a base64 encoded container", () => {
    const fp = GenerateFP(tone(440, 1));

    expect(typeof fp).toBe("string");
    expect(fp).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(decodeFingerprint(fp).length).toBeGreaterThan(0);
  });

  it("embeds the version, the duration and the peak table", () => {
    const samples = tone(440, 1);
    const raw = decodeFingerprint(GenerateFP(samples));

    const versionLength = raw.readUInt32LE(0);
    expect(versionLength).toBe(VERSION.length);
    expect(raw.subarray(4, 4 + versionLength).toString("ascii")).toBe(VERSION);

    const duration = raw.readFloatLE(4 + versionLength + 8);
    expect(duration).toBeCloseTo(samples.length / SAMPLE_RATE, 5);

    const body = raw.toString("latin1");
    expect(body).toContain("FPVER");
    expect(body).toContain("Peak");
    expect(body.indexOf("Peak")).toBeGreaterThan(body.indexOf("FPVER"));
  });

  it("emits one 12-byte record per peak and keeps the peak count in sync", () => {
    const raw = decodeFingerprint(GenerateFP(tone(440, 1)));

    const peaksIndex = raw.indexOf("Peak", 0, "latin1");
    expect(peaksIndex).toBeGreaterThan(0);

    const peakCount = raw.readUInt32LE(peaksIndex + 4);
    const peakBytes = raw.length - (peaksIndex + 8);

    expect(peakCount).toBeGreaterThan(0);
    expect(peakBytes).toBe(peakCount * 12);
  });

  it("keeps frequency bins inside the analysed band", () => {
    const raw = decodeFingerprint(GenerateFP(tone(440, 1)));

    const peaksIndex = raw.indexOf("Peak", 0, "latin1");
    const peakCount = raw.readUInt32LE(peaksIndex + 4);
    const lowBin = Math.trunc(100 / (SAMPLE_RATE / WINDOW_SIZE));
    const highBin = Math.trunc(4000 / (SAMPLE_RATE / WINDOW_SIZE));

    for (let i = 0; i < peakCount; i++) {
      const freqBin = raw.readUInt32LE(peaksIndex + 8 + i * 12);
      expect(freqBin).toBeGreaterThanOrEqual(lowBin);
      expect(freqBin).toBeLessThan(highBin);
    }
  });

  it("is deterministic", () => {
    const samples = tone(440, 1);

    expect(GenerateFP(samples)).toBe(GenerateFP(samples));
  });

  it("produces different fingerprints for different input", () => {
    expect(GenerateFP(tone(440, 1))).not.toBe(GenerateFP(tone(880, 1)));
  });

  it("handles input that is too short for a single analysis window", () => {
    const raw = decodeFingerprint(GenerateFP(new Float32Array(0)));

    const peaksIndex = raw.indexOf("Peak", 0, "latin1");
    expect(raw.readUInt32LE(peaksIndex + 4)).toBe(0);
    expect(raw.readFloatLE(4 + VERSION.length + 8)).toBe(0);
  });
});

import { createCipheriv } from "node:crypto";
import { deflateSync } from "node:zlib";
import { ipcMain } from "electron";
import FFT from "fft.js";

const VERSION = "hyai_1.2.0_client_1.0.0";
const VERSION_BYTES = new TextEncoder().encode(VERSION);
const AES_KEY = Buffer.from("4B97221F27F02907", "ascii");

const SAMPLE_RATE = 8000;
const WINDOW_SIZE = 2048;
const HOP_SIZE = 160;
const BIN_HZ = SAMPLE_RATE / WINDOW_SIZE;
const LOW_BIN = Math.trunc(100 / BIN_HZ);
const HIGH_BIN = Math.trunc(4000 / BIN_HZ);
const BAND_BINS = HIGH_BIN - LOW_BIN;
const MIN_FRAMES = 10;

type Peak = {
  freqBin: number;
  timeFrame: number;
  amplitude: number;
};

type ExtractConfig = {
  finalFreqRadius: number;
  finalTimeRadius: number;
  postprocessEnabled: boolean;
  postprocessMode: number;
  avgFreqRadius: number;
  avgTimeRadius: number;
  avgThreshold: number;
};

const DEFAULT_EXTRACT_CONFIG: ExtractConfig = {
  finalFreqRadius: 30,
  finalTimeRadius: 8,
  postprocessEnabled: true,
  postprocessMode: 1,
  avgFreqRadius: 10,
  avgTimeRadius: 5,
  avgThreshold: 1,
};

const hammingWindow = (() => {
  const win = new Float32Array(WINDOW_SIZE);
  for (let i = 0; i < WINDOW_SIZE; i++) {
    win[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WINDOW_SIZE - 1));
  }
  return win;
})();

const fft = new FFT(WINDOW_SIZE);

function stftPower(samples: Float32Array): Float32Array[] {
  if (samples.length < WINDOW_SIZE) return [];

  const frameCount = Math.floor((samples.length - WINDOW_SIZE) / HOP_SIZE) + 1;
  const binCount = WINDOW_SIZE / 2 + 1;
  const frames: Float32Array[] = new Array(frameCount);
  const input = fft.createComplexArray();
  const output = fft.createComplexArray();

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * HOP_SIZE;
    for (let i = 0; i < WINDOW_SIZE; i++) {
      input[2 * i] = samples[start + i] * hammingWindow[i];
      input[2 * i + 1] = 0;
    }

    fft.transform(output, input);

    const power = new Float32Array(binCount);
    for (let k = 0; k < binCount; k++) {
      const re = output[2 * k];
      const im = output[2 * k + 1];
      power[k] = re * re + im * im;
    }
    frames[frame] = power;
  }

  return frames;
}

function buildFeatureMatrix(powerFrames: Float32Array[]): Float32Array[] {
  const frameCount = powerFrames.length;
  if (frameCount === 0) return [];

  const matrix: Float32Array[] = new Array(BAND_BINS);
  for (let f = 0; f < BAND_BINS; f++) {
    matrix[f] = new Float32Array(frameCount);
  }

  let sum = 0;
  let count = 0;
  for (let t = 0; t < frameCount; t++) {
    const power = powerFrames[t];
    for (let f = 0; f < BAND_BINS; f++) {
      const value = Math.log(
        Math.max(Math.sqrt(power[LOW_BIN + f]), 1.11920929e-6)
      );
      matrix[f][t] = value;
      sum += value;
      count++;
    }
  }

  const mean = sum / count;
  for (let f = 0; f < BAND_BINS; f++) {
    const row = matrix[f];
    for (let t = 0; t < frameCount; t++) {
      row[t] = row[t] - mean;
    }
  }

  return matrix;
}

function hasGreaterInNeighborhood(
  matrix: Float32Array[],
  freq: number,
  time: number,
  freqRadius: number,
  timeRadius: number
): boolean {
  const bandBins = matrix.length;
  const frameCount = matrix[0]?.length ?? 0;
  const center = matrix[freq][time];
  const f0 = Math.max(0, freq - freqRadius);
  const f1 = Math.min(bandBins, freq + freqRadius + 1);
  const t0 = Math.max(0, time - timeRadius);
  const t1 = Math.min(frameCount, time + timeRadius + 1);

  for (let f = f0; f < f1; f++) {
    const row = matrix[f];
    for (let t = t0; t < t1; t++) {
      if (row[t] > center) return true;
    }
  }
  return false;
}

function filterByLocalAverage(
  peaks: Peak[],
  matrix: Float32Array[],
  cfg: ExtractConfig
): Peak[] {
  const bandBins = matrix.length;
  const frameCount = matrix[0]?.length ?? 0;
  const kept: Peak[] = [];

  for (const peak of peaks) {
    const f = peak.freqBin;
    const t = peak.timeFrame;
    const amp = matrix[f][t];
    if (amp <= 0) continue;

    const f0 = Math.max(0, f - cfg.avgFreqRadius);
    const f1 = Math.min(bandBins, f + cfg.avgFreqRadius + 1);
    const t0 = Math.max(0, t - cfg.avgTimeRadius);
    const t1 = Math.min(frameCount, t + cfg.avgTimeRadius + 1);
    if (f0 >= f1 || t0 >= t1) continue;

    let sum = 0;
    for (let nf = f0; nf < f1; nf++) {
      const row = matrix[nf];
      for (let nt = t0; nt < t1; nt++) sum += row[nt];
    }

    const avg = sum / ((f1 - f0) * (t1 - t0));
    if (avg > 2 || amp - avg > cfg.avgThreshold) {
      kept.push(peak);
    }
  }

  return kept;
}

function filterByF227Shape(peaks: Peak[], matrix: Float32Array[]): Peak[] {
  const bandBins = matrix.length;
  const frameCount = matrix[0]?.length ?? 0;
  const kept: Peak[] = [];

  for (const peak of peaks) {
    const f0 = Math.max(0, peak.freqBin - 1);
    const f1 = Math.min(bandBins, peak.freqBin + 2);
    const t0 = Math.max(0, peak.timeFrame - 1);
    const t1 = Math.min(frameCount, peak.timeFrame + 2);
    let reject = false;

    for (let f = f0; f < f1 && !reject; f++) {
      for (let t = t0; t < t1 && !reject; t++) {
        const center = matrix[f][t];
        const nf0 = Math.max(0, f - 1);
        const nf1 = Math.min(bandBins, f + 2);
        const nt0 = Math.max(0, t - 1);
        const nt1 = Math.min(frameCount, t + 2);
        let hasLower = false;

        for (let nf = nf0; nf < nf1 && !hasLower; nf++) {
          const row = matrix[nf];
          for (let nt = nt0; nt < nt1; nt++) {
            if (row[nt] < center) {
              hasLower = true;
              break;
            }
          }
        }

        if (!hasLower) reject = true;
      }
    }

    if (!reject) kept.push(peak);
  }

  return kept;
}

function extractPeaks(
  matrix: Float32Array[],
  cfg = DEFAULT_EXTRACT_CONFIG
): Peak[] {
  const bandBins = matrix.length;
  const frameCount = matrix[0]?.length ?? 0;
  if (frameCount < MIN_FRAMES) return [];

  let peaks: Peak[] = [];
  for (let f = 0; f < bandBins; f++) {
    const row = matrix[f];
    for (let t = 0; t < frameCount; t++) {
      if (!hasGreaterInNeighborhood(matrix, f, t, 1, 1)) {
        peaks.push({ freqBin: f, timeFrame: t, amplitude: row[t] });
      }
    }
  }

  if (cfg.postprocessEnabled) {
    if (cfg.postprocessMode === 1) {
      peaks = filterByLocalAverage(peaks, matrix, cfg);
    } else if (cfg.postprocessMode === 2) {
      peaks = filterByF227Shape(peaks, matrix);
    } else if (cfg.postprocessMode === 3) {
      peaks = filterByF227Shape(
        filterByLocalAverage(peaks, matrix, cfg),
        matrix
      );
    }
  }

  peaks = peaks.filter(
    (peak) =>
      !hasGreaterInNeighborhood(
        matrix,
        peak.freqBin,
        peak.timeFrame,
        cfg.finalFreqRadius,
        cfg.finalTimeRadius
      )
  );

  for (const peak of peaks) peak.freqBin += LOW_BIN;
  peaks.sort((a, b) => a.timeFrame - b.timeFrame || a.freqBin - b.freqBin);
  return peaks;
}

function writeAscii(buf: Buffer, offset: number, text: string): number {
  return offset + buf.write(text, offset, "ascii");
}

function buildRawFingerprint(duration: number, peaks: Peak[]): Buffer {
  const raw = Buffer.alloc(79 + peaks.length * 12);
  let offset = 0;

  raw.writeUInt32LE(VERSION_BYTES.length, offset);
  offset += 4;
  Buffer.from(VERSION_BYTES).copy(raw, offset);
  offset += VERSION_BYTES.length;
  raw.fill(0, offset, offset + 8);
  offset += 8;
  raw.writeFloatLE(duration, offset);
  offset += 4;
  offset = writeAscii(raw, offset, "FPVER");
  raw.writeUInt32LE(VERSION_BYTES.length, offset);
  offset += 4;
  Buffer.from(VERSION_BYTES).copy(raw, offset);
  offset += VERSION_BYTES.length;
  offset = writeAscii(raw, offset, "Peak");
  raw.writeUInt32LE(peaks.length, offset);
  offset += 4;

  for (const peak of peaks) {
    raw.writeUInt32LE(peak.freqBin >>> 0, offset);
    raw.writeUInt32LE(peak.timeFrame >>> 0, offset + 4);
    raw.writeFloatLE(peak.amplitude, offset + 8);
    offset += 12;
  }

  return raw;
}

function encryptRawFingerprint(raw: Buffer): string {
  const compressed = deflateSync(raw);
  const cipher = createCipheriv("aes-128-ecb", AES_KEY, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(compressed), cipher.final()]).toString(
    "base64"
  );
}

export function GenerateFP(samples: Float32Array): string {
  const duration = samples.length / SAMPLE_RATE;
  const power = stftPower(samples);
  const matrix = buildFeatureMatrix(power);
  const peaks = extractPeaks(matrix);
  return encryptRawFingerprint(buildRawFingerprint(duration, peaks));
}

ipcMain.handle("afp.generateFP", (_event, data: ArrayBuffer) => {
  return GenerateFP(new Float32Array(data));
});

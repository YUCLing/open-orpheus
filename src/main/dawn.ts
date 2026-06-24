import { randomBytes, randomUUID } from "node:crypto";
import { zstdCompress as zstdCompressCb } from "node:zlib";
import { promisify } from "node:util";

const zstdCompress = promisify(zstdCompressCb);

import { getCookies } from "./cookie";
import { client as httpClient } from "./request";
import { chacha20Encrypt, rawRsaEncrypt } from "./crypto";

const PID = process.pid;
const FIELD_SEP = "\x01";

// ── RSA Public Key (256-bit) ──
const RSA_MODULUS =
  0xfd90bd466ff9bc8a3fec2fbcf263b90d5c564879fa5d7aab89b31c1d5cb4139dn;
const RSA_EXPONENT = 65537n;

const MAX_QUEUE_SIZE = 20; // entries — flush immediately when queue reaches this count
const MAX_PENDING_BUNDLES = 50; // max pending bundles in RAM — drops oldest when exceeded
const DEBOUNCE_INTERVAL = 1000; // ms — flush when no new entries arrive for this long
const UPLOAD_INTERVAL = 30000; // ms — safety-net periodic upload interval

// ── NCBL Format Constants ──
const HEADER_FIXED_LEN = 70;
const META_BLOCK_TYPE = 0x4343;

function deriveNonceCounter(data: Buffer): { nonce: Buffer; counter: number } {
  return {
    nonce: data.subarray(0, 12),
    counter: data.readUInt32LE(12) >>> 2,
  };
}

// ── Internal State ──
const logBuffer: string[] = [];
let seqNum = 0;
let uploadUrl: string | null = null; // no default — must be set via setStatisEndpoint
let refererUrl: string | null = null;
const pendingBundles: { filename: string; data: Buffer }[] = [];
let uploadInProgress = false;

// ── Entry Formatting ──
// Per-entry format: time + '\x01' + action + '\x01' + JSON(data)
// Records are concatenated directly with no separator.

export interface DawnEntry {
  time?: string;
  action: string;
  data: string;
}

function formatEntry(entry: DawnEntry): string {
  const t = entry.time ? entry.time : Math.floor(Date.now() / 1000);
  return [t, entry.action, entry.data].join(FIELD_SEP);
}

// ── Build Metadata from Electron Cookies ──

async function buildMeta(): Promise<Buffer> {
  if (!uploadUrl) return Buffer.alloc(0);
  try {
    return Buffer.from(JSON.stringify(await getCookies(uploadUrl)));
  } catch {
    return Buffer.alloc(0);
  }
}

// ── Build Encrypted Bundle (in RAM — no filesystem) ──
// Structure: NCBL header (70 bytes) + metadata block (0x4343) + record frames
// - Metadata block: encrypted with keyB (RSA-wrapped keyA) via ChaCha20
// - Record frames: each entry is ZSTD-compressed independently,
//   then encrypted with keyA via ChaCha20, prefixed with u16 LE length + u32 LE seq

async function buildBundle(entries: string[], meta?: Buffer): Promise<Buffer> {
  const metaBuf = meta ?? Buffer.alloc(0);

  // Step 1: Generate per-bundle keys
  const uuid = randomBytes(16);
  uuid[6] = (uuid[6] & 0x0f) | 0x40; // RFC 4122 version 4
  uuid[8] = (uuid[8] & 0x3f) | 0x80; // RFC 4122 variant

  const keyA = randomBytes(32);
  keyA[0] &= 0x7f; // ensures keyA < RSA modulus for raw RSA encryption
  const keyB = rawRsaEncrypt(keyA, RSA_EXPONENT, RSA_MODULUS); // RSA-wrapped keyA for header
  const { nonce, counter } = deriveNonceCounter(uuid);
  const baseSeq = randomBytes(2).readUInt16LE(0);

  // Step 2: Metadata block (type 0x4343), encrypted with keyB
  const metaCipher = chacha20Encrypt(keyB, nonce, counter, metaBuf);
  const metaBlock = Buffer.concat([
    (() => {
      const h = Buffer.allocUnsafe(4);
      h.writeUInt16LE(META_BLOCK_TYPE, 0);
      h.writeUInt16LE(metaCipher.length, 2);
      return h;
    })(),
    metaCipher,
  ]);
  const headerLen = HEADER_FIXED_LEN + metaBlock.length;

  // Step 3: ZSTD compress each entry individually — one frame per entry
  const frames: Buffer[] = [];
  let seq = baseSeq;

  for (const entry of entries) {
    const compressed = await zstdCompress(Buffer.from(entry));
    const cipher = chacha20Encrypt(keyA, nonce, counter, compressed);
    const head = Buffer.allocUnsafe(6);
    head.writeUInt16LE(cipher.length, 0);
    head.writeUInt32LE(seq >>> 0, 2);
    frames.push(head, cipher);
    seq++;
  }

  // Empty body: emit exactly one empty frame
  if (frames.length === 0) {
    const compressed = await zstdCompress(Buffer.alloc(0));
    const cipher = chacha20Encrypt(keyA, nonce, counter, compressed);
    const head = Buffer.allocUnsafe(6);
    head.writeUInt16LE(cipher.length, 0);
    head.writeUInt32LE(seq >>> 0, 2);
    frames.push(head, cipher);
    seq++;
  }

  const trailing = Buffer.concat(frames);
  const frameCount = seq - baseSeq;

  // Step 4: Build header (HEADER_FIXED_LEN = 70 bytes)
  const header = Buffer.alloc(HEADER_FIXED_LEN);
  header.write("NCBL", 0); // magic
  header.writeUInt32LE(3, 4); // version
  header.writeUInt16LE(headerLen, 8); // header length (header + metadata block)
  uuid.copy(header, 10); // 16-byte UUID at offset 10
  keyB.copy(header, 26); // RSA-wrapped keyA at offset 26
  header.writeUInt32LE(baseSeq >>> 0, 58); // first record seq
  header.writeUInt32LE((baseSeq + frameCount - 1) >>> 0, 62); // last record seq
  header.writeUInt32LE(trailing.length, 66); // trailing region length

  return Buffer.concat([header, metaBlock, trailing]);
}

// ── Flush Buffer → RAM Bundle ──

async function flushToBundle(): Promise<void> {
  if (!logBuffer.length) return;

  // Snapshot and clear synchronously — prevents races when
  // statisV2 is called in bursts while buildMeta() is awaiting.
  const snapshot = logBuffer.splice(0);

  const randomNonce = randomBytes(4).readUInt32LE(0);
  const filename = `op_${PID}_${seqNum}_${randomNonce}`;
  seqNum++;
  const meta = await buildMeta();
  const bundle = await buildBundle(snapshot, meta);

  pendingBundles.push({ filename, data: bundle });

  // Enforce cap: drop oldest bundles when exceeded
  while (pendingBundles.length > MAX_PENDING_BUNDLES) {
    const dropped = pendingBundles.shift();
    if (dropped) {
      console.warn(
        `[dawn] Dropped oldest bundle: ${dropped.filename} — queue at ${pendingBundles.length + 1}/${MAX_PENDING_BUNDLES}`
      );
    }
  }

  // Upload immediately — fire-and-forget
  if (uploadUrl) {
    uploadBundles().catch(() => {});
  }

  // Reset the interval: each flush restarts the countdown
  scheduleFlush();
}

// ── Upload Pending Bundles ──

async function uploadBundles(): Promise<void> {
  if (!uploadUrl || pendingBundles.length === 0) return;
  if (uploadInProgress) return; // previous cycle still running

  uploadInProgress = true;
  try {
    const url = uploadUrl; // capture in case it changes mid-loop
    const referer = refererUrl ?? undefined;

    for (let i = 0; i < pendingBundles.length; i++) {
      const { filename, data } = pendingBundles[i];
      try {
        const boundary = randomUUID();
        const head = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([head, data, tail]);

        const r = await httpClient.post(url, {
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            Referer: referer,
          },
          body,
          throwHttpErrors: false,
          retry: {
            // Enable retry on this request, if still fails, we simply discard this bundle
            methods: ["POST"],
          },
        });

        if (r.statusCode !== 200) {
          console.error(
            `[dawn] Upload failed: ${filename} — HTTP ${r.statusCode}`
          );
          continue;
        }

        let res;
        try {
          res = JSON.parse(r.body);
        } catch {
          console.error(`[dawn] Upload unparseable response: ${filename}`);
          continue;
        }

        if (res.code === 200 && res.data?.successfiles?.includes?.(filename)) {
          pendingBundles.splice(i, 1);
          i--; // compensate for removed element
        } else {
          console.error(
            `[dawn] Upload rejected: ${filename} — ${JSON.stringify(res)}`
          );
        }
      } catch (e) {
        console.error(`[dawn] Upload error for ${filename}:`, e);
      }
    }
  } finally {
    uploadInProgress = false;
  }
}

// ── Periodic Flush Timer (resets on each flush) ──
// Uses setTimeout so each flush restarts the countdown.
// Fires only when entries are sitting in the buffer — never builds
// an empty bundle.

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDebounce(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (!uploadUrl) return;
  debounceTimer = setTimeout(() => {
    flushToBundle().catch(() => {});
  }, DEBOUNCE_INTERVAL);
  debounceTimer.unref();
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  if (!uploadUrl) return; // no endpoint yet — timer starts when set
  flushTimer = setTimeout(() => {
    flushToBundle().catch(() => {}); // no-op if logBuffer is empty
    scheduleFlush(); // reschedule for next interval
  }, UPLOAD_INTERVAL);
  flushTimer.unref();
}

// #region Public API

/**
 * Process dawn-log entries from the NCM web app.
 *
 * Called when the web app invokes `On.call("app.statisV2", "dawn", [...])`.
 * Entries are buffered in RAM. When the queue reaches {@link MAX_QUEUE_SIZE}
 * entries they are encrypted into a bundle and queued for upload.
 *
 * If no endpoint has been set via {@link setStatisEndpoint}, bundles simply
 * accumulate in RAM until the endpoint is configured.
 *
 * @param type   The statis type — only `"dawn"` entries are processed.
 * @param entries Array of log entries to buffer.
 */
export function statisV2(type: string, entries: DawnEntry[]): void {
  if (type !== "dawn") return;

  for (const e of entries) {
    logBuffer.push(formatEntry(e));
  }

  if (logBuffer.length >= MAX_QUEUE_SIZE) {
    // Burst filled the queue — flush immediately, cancel debounce
    if (debounceTimer) clearTimeout(debounceTimer);
    flushToBundle().catch(() => {});
  } else {
    // Still under limit — debounce: flush as soon as entries stop arriving
    scheduleDebounce();
  }
}

/**
 * Set the remote upload endpoint and begin periodic uploads.
 *
 * There is no default URL — uploads will not occur until this is called.
 * Typically wired to the `dawn` field from `app.initUrls`.
 *
 * Any bundles queued before calling this function will be uploaded
 * on the next timer tick.
 *
 * @param url The full upload URL.
 * @param referer The Referer URL to be used when uploading.
 */
export function setStatisEndpoint(url: string, referer?: string): void {
  uploadUrl = url;
  refererUrl = referer ?? null;
  scheduleFlush();
}

// #endregion

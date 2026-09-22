import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

/**
 * Detect whether a local file carries an AV3A audio track.
 *
 * AV3A lives inside an ISO base media file (M4A/MP4), and — matching the
 * decoder (`avs3a-rust` `mp4.rs`) — the only signal is the `stsd` sample-entry
 * fourcc `"av3a"`:
 *
 *     pub const AV3A_SAMPLE_ENTRY: [u8; 4] = *b"av3a";
 *
 * So this walks the file's top-level boxes, reads only `moov` (never the media
 * payload), and checks whether any track's `stsd` lists an `av3a` entry. Files
 * that are not ISO-BMFF (no `ftyp` at byte 4) short-circuit after one read.
 */

/** The `stsd` sample-entry format that identifies an AV3A track. */
const AV3A_FORMAT = "av3a";
/** Cap on how much of a `moov` box is read into memory (real ones are small). */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

/**
 * Whether `path` is an ISO-BMFF file carrying an AV3A track. Detection is a
 * few small reads (never the media payload), so it is deliberately uncached —
 * callers re-sniff per load and the cost is negligible.
 */
export async function isAv3aFile(path: string): Promise<boolean> {
  return sniff(path);
}

async function sniff(path: string): Promise<boolean> {
  let fh: FileHandle | null = null;
  try {
    fh = await open(path, "r");
    const fileSize = (await fh.stat()).size;

    // Not ISO-BMFF unless bytes 4..8 are `ftyp`.
    const head = Buffer.alloc(8);
    const headRead = await fh.read(head, 0, 8, 0);
    if (headRead.bytesRead < 8 || head.toString("latin1", 4, 8) !== "ftyp") {
      return false;
    }

    // Walk top-level boxes; only `moov` is read in full, everything else is
    // skipped by offset (so a huge `mdat` costs one header read).
    let pos = 0;
    while (pos + 8 <= fileSize) {
      const header = Buffer.alloc(16);
      const { bytesRead } = await fh.read(header, 0, 16, pos);
      if (bytesRead < 8) break;

      let size = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      let headerLen = 8;

      if (size === 1) {
        // 64-bit extended size (reject sizes that overflow a JS safe integer).
        if (bytesRead < 16) break;
        const hi = header.readUInt32BE(8);
        const lo = header.readUInt32BE(12);
        if (hi > 0x1fffff) return false;
        size = hi * 0x100000000 + lo;
        headerLen = 16;
      } else if (size === 0) {
        size = fileSize - pos; // box extends to the end of the file
      }

      if (size < headerLen) return false; // corrupt size

      if (type === "moov") {
        const payloadLen = size - headerLen;
        if (payloadLen > MAX_MOOV_BYTES) return false;
        const payload = Buffer.alloc(payloadLen);
        const payloadRead = await fh.read(
          payload,
          0,
          payloadLen,
          pos + headerLen
        );
        if (payloadRead.bytesRead < payloadLen) return false;
        if (moovHasAv3a(payload)) return true;
      }

      pos += size;
    }
    return false;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Iterate the child boxes inside a container's payload. */
function forEachBox(
  buf: Buffer,
  visit: (type: string, content: Buffer) => void
): void {
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let headerLen = 8;
    if (size === 1) {
      if (off + 16 > buf.length) return;
      const hi = buf.readUInt32BE(off + 8);
      const lo = buf.readUInt32BE(off + 12);
      if (hi > 0x1fffff) return;
      size = hi * 0x100000000 + lo;
      headerLen = 16;
    } else if (size === 0) {
      return; // only valid at the end of a real file, not a nested buffer
    }
    if (size < headerLen || off + size > buf.length) return;
    visit(type, buf.subarray(off + headerLen, off + size));
    off += size;
  }
}

/** Containers on the path from `moov` down to `stsd`. */
const CONTAINER_TYPES = new Set(["trak", "mdia", "minf", "stbl"]);

/** Whether any `stsd` reachable inside the `moov` payload has an AV3A entry. */
function moovHasAv3a(moovPayload: Buffer): boolean {
  let found = false;

  const walk = (payload: Buffer): void => {
    forEachBox(payload, (type, content) => {
      if (found) return;
      if (type === "stsd") {
        found = stsdHasAv3a(content);
      } else if (CONTAINER_TYPES.has(type)) {
        walk(content);
      }
    });
  };

  walk(moovPayload);
  return found;
}

/** `stsd`: version/flags (4) + entry count (4), then `size + format` entries. */
function stsdHasAv3a(stsd: Buffer): boolean {
  if (stsd.length < 8) return false;
  const entryCount = stsd.readUInt32BE(4);
  let off = 8;
  for (let i = 0; i < entryCount; i++) {
    if (off + 8 > stsd.length) return false;
    const size = stsd.readUInt32BE(off);
    const format = stsd.toString("latin1", off + 4, off + 8);
    if (format === AV3A_FORMAT) return true;
    if (size < 8) return false;
    off += size;
  }
  return false;
}

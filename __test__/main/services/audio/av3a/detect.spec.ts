import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { vol } from "memfs";

import { isAv3aFile } from "@main/services/audio/av3a/detect";

/** Build an ISO-BMFF box: 4-byte big-endian size + 4-byte type + payload. */
function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32BE(buf.length, 0);
  buf.write(type, 4, "latin1");
  payload.copy(buf, 8);
  return buf;
}

/** Same, but using the 64-bit extended size form (size field == 1). */
function extendedBox(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const buf = Buffer.alloc(16 + payload.length);
  buf.writeUInt32BE(1, 0);
  buf.write(type, 4, "latin1");
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(buf.length, 12);
  payload.copy(buf, 16);
  return buf;
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

/** `stsd` sample description listing the given sample-entry fourccs. */
function stsd(...formats: string[]): Buffer {
  const entries = formats.map((format) => box(format, Buffer.alloc(8)));
  return box(
    "stsd",
    Buffer.concat([Buffer.alloc(4), u32(formats.length), ...entries])
  );
}

/** `moov` containing one track whose `stbl` has the given sample entries. */
function moov(...formats: string[]): Buffer {
  const stbl = box("stbl", stsd(...formats));
  const minf = box("minf", stbl);
  const mdia = box("mdia", minf);
  const trak = box("trak", mdia);
  return box("moov", trak);
}

function isoFile(...formats: string[]): Buffer {
  return Buffer.concat([
    box("ftyp", Buffer.from("isomiso2", "latin1")),
    moov(...formats),
  ]);
}

function write(path: string, content: Buffer) {
  vol.writeFileSync(path, content);
}

describe("isAv3aFile", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("detects an av3a sample entry", async () => {
    write("/song.m4a", isoFile("av3a"));
    await expect(isAv3aFile("/song.m4a")).resolves.toBe(true);
  });

  it("detects av3a among other sample entries", async () => {
    write("/song.m4a", isoFile("mp4a", "av3a"));
    await expect(isAv3aFile("/song.m4a")).resolves.toBe(true);
  });

  it("rejects files without an av3a entry", async () => {
    write("/song.m4a", isoFile("mp4a"));
    await expect(isAv3aFile("/song.m4a")).resolves.toBe(false);

    write(
      "/empty-moov.m4a",
      Buffer.concat([
        box("ftyp", Buffer.from("isomiso2", "latin1")),
        box(
          "moov",
          box("trak", box("mdia", box("minf", box("stbl", Buffer.alloc(0)))))
        ),
      ])
    );
    await expect(isAv3aFile("/empty-moov.m4a")).resolves.toBe(false);
  });

  it("skips over other top-level boxes", async () => {
    write(
      "/with-mdat.m4a",
      Buffer.concat([
        box("ftyp", Buffer.from("isomiso2", "latin1")),
        extendedBox("mdat", Buffer.alloc(32)),
        box("free", Buffer.alloc(16)),
        moov("av3a"),
      ])
    );
    await expect(isAv3aFile("/with-mdat.m4a")).resolves.toBe(true);
  });

  it("handles a moov box that extends to the end of the file", async () => {
    const ftyp = box("ftyp", Buffer.from("isomiso2", "latin1"));
    const rest = moov("av3a");
    rest.writeUInt32BE(0, 0); // size 0 → box runs to EOF
    write("/open-ended.m4a", Buffer.concat([ftyp, rest]));

    await expect(isAv3aFile("/open-ended.m4a")).resolves.toBe(true);
  });

  it("rejects files that are not ISO-BMFF", async () => {
    write(
      "/not-video.txt",
      Buffer.from("just some text, definitely not an mp4")
    );
    await expect(isAv3aFile("/not-video.txt")).resolves.toBe(false);
  });

  it("rejects files that are too short to hold a ftyp box", async () => {
    write("/tiny.m4a", Buffer.from([0, 0, 0, 0]));
    await expect(isAv3aFile("/tiny.m4a")).resolves.toBe(false);

    write("/empty.m4a", Buffer.alloc(0));
    await expect(isAv3aFile("/empty.m4a")).resolves.toBe(false);
  });

  it("rejects files with corrupt box sizes", async () => {
    const ftyp = box("ftyp", Buffer.from("isomiso2", "latin1"));
    const corrupt = box("moov", Buffer.alloc(4));
    corrupt.writeUInt32BE(2, 0); // smaller than the 8 byte header
    write("/corrupt.m4a", Buffer.concat([ftyp, corrupt]));

    await expect(isAv3aFile("/corrupt.m4a")).resolves.toBe(false);
  });

  it("resolves to false when the file cannot be read", async () => {
    await expect(isAv3aFile("/does/not/exist.m4a")).resolves.toBe(false);
  });
});

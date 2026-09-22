import { beforeAll, describe, expect, it } from "vitest";

import {
  commentToID3Json,
  commentToID3Metadata,
  ID3JsonToComment,
  type ID3MusicMetadata,
} from "@main/domain/id3";
import { installLoggerStub } from "../../helpers/globals";

beforeAll(() => {
  installLoggerStub();
});

const sampleMetadata: ID3MusicMetadata = {
  musicId: "1234567",
  musicName: "不完美人生指南",
  artist: [["1", "Someone"]],
  albumId: "99",
  album: "Album",
  albumPicDocId: "1",
  albumPic: "https://p1.music.126.net/a.jpg",
  bitrate: 320000,
  mp3DocId: "abc",
  duration: 180000,
  mvId: "0",
  alias: [],
  transNames: [],
  format: "mp3",
  fee: 0,
  volumeDelta: 0,
  privilege: { flag: 0 },
};

describe("ID3JsonToComment", () => {
  it("prefixes the encrypted payload", () => {
    const comment = ID3JsonToComment('{"a":1}');
    expect(comment.startsWith("163 key(Don't modify):")).toBe(true);
    // The payload is single base64 (no double encoding).
    expect(comment.slice("163 key(Don't modify):".length)).toMatch(
      /^[A-Za-z0-9+/]+={0,2}$/
    );
  });

  it("encrypts, so the raw JSON is not visible", () => {
    expect(ID3JsonToComment('{"secret":true}')).not.toContain("secret");
  });
});

describe("commentToID3Json", () => {
  it("round trips with ID3JsonToComment", () => {
    const json = JSON.stringify(sampleMetadata);
    expect(commentToID3Json(ID3JsonToComment(json))).toBe(json);
  });

  it("tolerates surrounding whitespace", () => {
    const comment = ID3JsonToComment('{"a":1}');
    expect(commentToID3Json(`  ${comment}  `)).toBe('{"a":1}');
  });

  it("returns null for missing or foreign comments", () => {
    expect(commentToID3Json(null)).toBeNull();
    expect(commentToID3Json("")).toBeNull();
    expect(commentToID3Json("just a comment")).toBeNull();
    expect(commentToID3Json("163 key(Don't modify):")).toBeNull();
  });

  it("returns null for a payload that cannot be decrypted", () => {
    expect(commentToID3Json("163 key(Don't modify):!!!")).toBeNull();
  });
});

describe("commentToID3Metadata", () => {
  it("parses the music payload from a comment", () => {
    const comment = ID3JsonToComment(`music:${JSON.stringify(sampleMetadata)}`);
    expect(commentToID3Metadata(comment)).toEqual(sampleMetadata);
  });

  it("returns null when the payload has no `music:` prefix", () => {
    const comment = ID3JsonToComment(JSON.stringify(sampleMetadata));
    expect(commentToID3Metadata(comment)).toBeNull();
  });

  it("returns null when the payload is not JSON", () => {
    const comment = ID3JsonToComment("music:not json at all");
    expect(commentToID3Metadata(comment)).toBeNull();
  });

  it("returns null for missing or foreign comments", () => {
    expect(commentToID3Metadata(null)).toBeNull();
    expect(commentToID3Metadata("random comment")).toBeNull();
  });
});

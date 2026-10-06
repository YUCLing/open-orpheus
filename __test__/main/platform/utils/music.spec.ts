import { describe, expect, it } from "vitest";

import type { MetaPicture } from "music-tag-native";

import { isMusicFile, selectBestMusicPic } from "@main/platform/utils/music";

describe("selectBestMusicPic", () => {
  const pic = (coverType: string) => ({ coverType }) as MetaPicture;

  it("prefers the front cover", () => {
    const front = pic("Cover Art (Front)");
    expect(selectBestMusicPic([pic("Cover Art (Back)"), front, pic("Other")])).toBe(front);
  });

  it("falls back to the first picture", () => {
    const first = pic("Other");
    expect(selectBestMusicPic([first, pic("Back")])).toBe(first);
  });

  it("returns null when there are no pictures", () => {
    expect(selectBestMusicPic([])).toBeNull();
  });
});

describe("isMusicFile", () => {
  it("recognises audio mime types", () => {
    expect(isMusicFile("song.mp3")).toBe(true);
    expect(isMusicFile("/music/track.flac")).toBe(true);
    expect(isMusicFile("recording.wav")).toBe(true);
  });

  it("rejects non-audio files", () => {
    expect(isMusicFile("cover.jpg")).toBe(false);
    expect(isMusicFile("notes.txt")).toBe(false);
    expect(isMusicFile("no-extension")).toBe(false);
  });
});

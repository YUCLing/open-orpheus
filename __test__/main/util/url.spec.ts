import { describe, expect, it } from "vitest";

import { isAppUrl, isNCMUrl } from "@main/util/url";

describe("isNCMUrl", () => {
  it.each([
    "https://music.163.com/",
    "https://music.163.com/api/pc/upgrade/get",
    "https://interfacepc.music.163.com/api/music/audio/match",
    "https://p1.music.163.com/cover.jpg",
  ])("accepts %s", (url) => {
    expect(isNCMUrl(url)).toBe(true);
    expect(isNCMUrl(new URL(url))).toBe(true);
  });

  it.each([
    "https://evilmusic.163.com/",
    "https://notmusic.163.com/",
    "https://music.163.com.evil.example/",
    "https://music.163.community/",
    "https://163.com/",
    "https://orpheus.163.com/",
    "not a url",
  ])("rejects %s", (url) => {
    expect(isNCMUrl(url)).toBe(false);
  });
});

describe("isAppUrl", () => {
  it("accepts the app protocol", () => {
    expect(isAppUrl("orpheus://orpheus/index.html")).toBe(true);
    expect(isAppUrl(new URL("orpheus://orpheus/"))).toBe(true);
  });

  it("rejects other origins and malformed URLs", () => {
    expect(isAppUrl("https://orpheus/")).toBe(false);
    expect(isAppUrl("orpheus://evil/")).toBe(false);
    expect(isAppUrl("not a url")).toBe(false);
  });
});

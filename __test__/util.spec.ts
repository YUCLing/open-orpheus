import { describe, expect, it } from "vitest";

import { dbToGain, imageSize, toError } from "@shared/util";

describe("toError", () => {
  it("returns the same instance for an Error", () => {
    const err = new Error("boom");
    expect(toError(err)).toBe(err);
  });

  it("wraps non-Error throwables", () => {
    expect(toError("boom").message).toBe("boom");
    expect(toError(42).message).toBe("42");
    expect(toError(undefined).message).toBe("undefined");
  });
});

describe("imageSize (read)", () => {
  it("reads the size from `param`", () => {
    expect(imageSize("https://p1.music.126.net/a.jpg?param=200y300")).toEqual([
      200, 300,
    ]);
  });

  it("falls back to `thumbnail`", () => {
    expect(
      imageSize("https://p1.music.126.net/a.jpg?thumbnail=640y640")
    ).toEqual([640, 640]);
  });

  it("prefers `param` over `thumbnail`", () => {
    expect(
      imageSize("https://p1.music.126.net/a.jpg?param=1y2&thumbnail=3y4")
    ).toEqual([1, 2]);
  });

  it("returns null when no size parameter is present", () => {
    expect(imageSize("https://p1.music.126.net/a.jpg")).toBeNull();
  });
});

describe("imageSize (write)", () => {
  it("uses a single size for both dimensions", () => {
    const result = imageSize("https://p1.music.126.net/a.jpg", 512);
    const url = new URL(result);
    expect(url.searchParams.get("param")).toBe("512y512");
  });

  it("honours an explicit height", () => {
    const result = imageSize("https://p1.music.126.net/a.jpg", 700, 400);
    const url = new URL(result);
    expect(url.searchParams.get("param")).toBe("700y400");
  });

  it("replaces an existing param and drops the legacy thumbnail", () => {
    const result = imageSize(
      "https://p1.music.126.net/a.jpg?param=100y100&thumbnail=100y100",
      800
    );
    const url = new URL(result);
    expect(url.searchParams.get("param")).toBe("800y800");
    expect(url.searchParams.has("thumbnail")).toBe(false);
  });

  it("keeps unrelated query parameters", () => {
    const result = imageSize(
      "https://p1.music.126.net/a.jpg?token=abc&param=100y100",
      64
    );
    const url = new URL(result);
    expect(url.searchParams.get("token")).toBe("abc");
    expect(url.searchParams.get("param")).toBe("64y64");
  });

  it("treats height 0 as an explicit size", () => {
    expect(imageSize("https://p1.music.126.net/a.jpg", 0)).toContain("0y0");
  });
});

describe("dbToGain", () => {
  it("maps 0 dB to unity gain", () => {
    expect(dbToGain(0)).toBe(1);
  });

  it("maps +20 dB to 10x", () => {
    expect(dbToGain(20)).toBeCloseTo(10, 10);
  });

  it("maps -6 dB to about half gain", () => {
    expect(dbToGain(-6)).toBeCloseTo(0.5011872336, 9);
  });

  it("maps -Infinity dB to silence", () => {
    expect(dbToGain(-Infinity)).toBe(0);
  });
});

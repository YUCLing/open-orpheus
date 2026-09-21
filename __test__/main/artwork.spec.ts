import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");
vi.mock("music-tag-native", () => ({
  MusicFile: { load: vi.fn() },
  MetaPicture: class {},
}));
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => `/tmp/open-orpheus-test/${name}`),
    isPackaged: false,
  },
}));

import { vol } from "memfs";

import { MusicFile } from "music-tag-native";

import {
  ART_CACHE_DIR,
  artworkCachePath,
  artworkFileExists,
  artworkFileUrl,
  cacheArtwork,
  nativeArtUrl,
  remoteArtExt,
  resolveCoverUrl,
  resolveEmbeddedArtwork,
} from "@main/playback/artwork";

const orpheusCoverUrl = (filePath: string) =>
  `orpheus://localmusic/pic?${encodeURIComponent(filePath)}`;

function picture(overrides: Record<string, unknown> = {}) {
  return {
    coverType: "Cover Art (Front)",
    data: new Uint8Array([1, 2, 3, 4]),
    mimeType: "image/png",
    ...overrides,
  };
}

describe("remoteArtExt", () => {
  it("uses the URL extension", () => {
    expect(remoteArtExt("https://p1.music.126.net/a.jpg")).toBe(".jpg");
    expect(remoteArtExt("https://p1.music.126.net/b.PNG")).toBe(".PNG");
    expect(remoteArtExt("https://p1.music.126.net/c.webp")).toBe(".webp");
  });

  it("ignores the query string", () => {
    expect(remoteArtExt("https://p1.music.126.net/a.jpg?param=100y100")).toBe(
      ".jpg"
    );
  });

  it("defaults to .jpg", () => {
    expect(remoteArtExt("https://p1.music.126.net/cover")).toBe(".jpg");
    expect(remoteArtExt("not a url")).toBe(".jpg");
    expect(remoteArtExt("")).toBe(".jpg");
  });
});

describe("artwork paths", () => {
  it("places the artwork inside the thumbnail cache directory", () => {
    expect(artworkCachePath("123", ".jpg")).toBe(`${ART_CACHE_DIR}/123.jpg`);
    expect(ART_CACHE_DIR.endsWith("/thumbnails")).toBe(true);
  });

  it("exposes a file:// URL", () => {
    const url = artworkFileUrl("123", ".jpg");
    expect(url.startsWith("file://")).toBe(true);
    expect(url.endsWith("/123.jpg")).toBe(true);
  });

  it("reports whether the artwork is cached", async () => {
    await expect(artworkFileExists("missing", ".jpg")).resolves.toBe(false);

    await cacheArtwork("present", new Uint8Array([1, 2]), ".jpg");
    await expect(artworkFileExists("present", ".jpg")).resolves.toBe(true);
    await expect(artworkFileExists("present", ".png")).resolves.toBe(false);
  });
});

describe("cacheArtwork", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("writes the bytes and returns the file URL", async () => {
    const url = await cacheArtwork("1", new Uint8Array([9, 8, 7]), ".png");

    expect(url).toBe(artworkFileUrl("1", ".png"));
    const bytes = await vol.promises.readFile(artworkCachePath("1", ".png"));
    expect(bytes).toEqual(Buffer.from([9, 8, 7]));
  });

  it("keeps the existing file when called twice", async () => {
    await cacheArtwork("2", new Uint8Array([1]), ".jpg");
    await cacheArtwork("2", new Uint8Array([2, 2]), ".jpg");

    const bytes = await vol.promises.readFile(artworkCachePath("2", ".jpg"));
    expect(bytes).toEqual(Buffer.from([1]));
  });

  it("prunes the cache back to its bounded size", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) {
      await cacheArtwork(id, new Uint8Array([1]), ".jpg");
    }

    const entries = await vol.promises.readdir(ART_CACHE_DIR);
    expect(entries.length).toBeLessThanOrEqual(3);
    // The newest entry is always kept.
    expect(entries).toContain("e.jpg");
  });
});

describe("nativeArtUrl", () => {
  it("passes empty and already-local URLs through", () => {
    expect(nativeArtUrl("")).toBe("");
    expect(nativeArtUrl("file:///tmp/a.jpg")).toBe("file:///tmp/a.jpg");
    expect(nativeArtUrl("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA"
    );
  });

  it("requests a small square for remote covers", () => {
    const url = nativeArtUrl("https://p1.music.126.net/a.jpg?param=100y100");
    expect(new URL(url).searchParams.get("param")).toBe("512y512");
  });

  it("returns unusable URLs untouched", () => {
    expect(nativeArtUrl("not a url")).toBe("not a url");
  });
});

describe("resolveEmbeddedArtwork", () => {
  beforeEach(() => {
    vol.reset();
    vi.mocked(MusicFile.load).mockReset();
  });

  it("extracts and caches the embedded picture", async () => {
    vi.mocked(MusicFile.load).mockResolvedValue({
      pictures: [picture()],
    } as never);

    const url = await resolveEmbeddedArtwork(
      orpheusCoverUrl("/music/song.flac"),
      "42"
    );

    expect(MusicFile.load).toHaveBeenCalledWith("/music/song.flac");
    expect(url).toBe(artworkFileUrl("42", ".png"));
    expect(
      (await vol.promises.readFile(artworkCachePath("42", ".png"))).length
    ).toBe(4);
  });

  it("falls back to .jpg when the mime type is unknown", async () => {
    vi.mocked(MusicFile.load).mockResolvedValue({
      pictures: [picture({ mimeType: undefined })],
    } as never);

    await expect(
      resolveEmbeddedArtwork(orpheusCoverUrl("/a.mp3"), "43")
    ).resolves.toBe(artworkFileUrl("43", ".jpg"));
  });

  it("ignores foreign URLs", async () => {
    await expect(
      resolveEmbeddedArtwork("https://example.com/a.jpg", "44")
    ).resolves.toBeNull();
    await expect(resolveEmbeddedArtwork("", "44")).resolves.toBeNull();
  });

  it("ignores other orpheus endpoints", async () => {
    await expect(
      resolveEmbeddedArtwork("orpheus://localmusic/other?x", "44")
    ).resolves.toBeNull();
    await expect(
      resolveEmbeddedArtwork("orpheus://orpheus/storage/local?file=a", "44")
    ).resolves.toBeNull();
  });

  it("ignores a cover URL without a file path", async () => {
    await expect(
      resolveEmbeddedArtwork("orpheus://localmusic/pic", "44")
    ).resolves.toBeNull();
  });

  it("returns null when the file has no picture", async () => {
    vi.mocked(MusicFile.load).mockResolvedValue({ pictures: null } as never);
    await expect(
      resolveEmbeddedArtwork(orpheusCoverUrl("/a.mp3"), "45")
    ).resolves.toBeNull();

    vi.mocked(MusicFile.load).mockResolvedValue({ pictures: [] } as never);
    await expect(
      resolveEmbeddedArtwork(orpheusCoverUrl("/a.mp3"), "45")
    ).resolves.toBeNull();
  });

  it("returns null when the file cannot be read", async () => {
    vi.mocked(MusicFile.load).mockRejectedValue(new Error("boom"));

    await expect(
      resolveEmbeddedArtwork(orpheusCoverUrl("/missing.mp3"), "46")
    ).resolves.toBeNull();
  });
});

describe("resolveCoverUrl", () => {
  beforeEach(() => {
    vol.reset();
    vi.mocked(MusicFile.load).mockReset();
  });

  it("returns an empty string without a cover", async () => {
    await expect(resolveCoverUrl(null, "1")).resolves.toBe("");
    await expect(resolveCoverUrl("", "1")).resolves.toBe("");
  });

  it("passes remote and local URLs through", async () => {
    await expect(
      resolveCoverUrl("https://p1.music.126.net/a.jpg", "1")
    ).resolves.toBe("https://p1.music.126.net/a.jpg");
    await expect(resolveCoverUrl("file:///tmp/a.jpg", "1")).resolves.toBe(
      "file:///tmp/a.jpg"
    );
  });

  it("extracts orpheus covers to a file URL", async () => {
    vi.mocked(MusicFile.load).mockResolvedValue({
      pictures: [picture()],
    } as never);

    await expect(
      resolveCoverUrl(orpheusCoverUrl("/music/song.flac"), "47")
    ).resolves.toBe(artworkFileUrl("47", ".png"));
  });

  it("returns an empty string when extraction fails", async () => {
    await expect(
      resolveCoverUrl(orpheusCoverUrl("/missing.mp3"), "48")
    ).resolves.toBe("");
  });
});

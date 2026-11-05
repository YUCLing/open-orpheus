import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  stream: vi.fn(),
  sevenZipFactory: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises");
vi.mock("../../src/main/folders", () => ({ pack: "/pack" }));
vi.mock("got", () => ({ default: { stream: hoisted.stream } }));
vi.mock("7z-wasm", () => ({ default: hoisted.sevenZipFactory }));

import packManager from "../../src/main/pack";

const LISTING = [
  "   Date      Time    Attr         Size   Compressed  Name",
  "------------------- ----- ------------ ------------  ------------------------",
  "2024-01-01 00:00:00 ....A 1 1 package/web.pack",
  "------------------- ----- ------------ ------------  ------------------------",
].join("\n");

function responseFor(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const response = {
    once(event: string, callback: (res: unknown) => void) {
      if (event === "response") {
        callback({
          statusCode: 200,
          statusMessage: "OK",
          headers: { "content-length": String(total) },
        });
      }
      return response;
    },
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  return response;
}

beforeEach(() => {
  vol.reset();
  vi.clearAllMocks();
  hoisted.sevenZipFactory.mockImplementation(
    async ({ stdout }: { stdout: (c: number) => void }) => ({
      FS: {
        open: vi.fn(() => 1),
        write: vi.fn(),
        close: vi.fn(),
        readFile: hoisted.readFile,
      },
      callMain(command: string[]) {
        if (command[0] === "l") {
          for (const char of LISTING) stdout(char.charCodeAt(0));
        }
      },
    })
  );
  hoisted.readFile.mockReturnValue(Buffer.from("new"));
});

describe("PackManager.downloadPackage cancellation", () => {
  it("rejects before starting when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(packManager.downloadPackage(undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(hoisted.stream).not.toHaveBeenCalled();
  });

  it("stops the transfer when cancelled while downloading", async () => {
    hoisted.stream.mockReturnValue(responseFor([Buffer.from("first"), Buffer.from("second")]));
    const controller = new AbortController();

    await expect(
      packManager.downloadPackage((progress) => {
        if (progress.step === "downloading" && progress.downloadedBytes) controller.abort();
      }, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(hoisted.sevenZipFactory).not.toHaveBeenCalled();
    expect(vol.existsSync("/pack.new")).toBe(false);
  });

  it("leaves the installed package untouched when cancelled before replacement", async () => {
    vol.fromJSON({ "/pack/old.txt": "old" });
    hoisted.stream.mockReturnValue(responseFor([Buffer.from("archive")]));
    const controller = new AbortController();

    await expect(
      packManager.downloadPackage((progress) => {
        if (progress.step === "saving" && progress.fileIndex === progress.fileCount) {
          controller.abort();
        }
      }, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(vol.existsSync("/pack/old.txt")).toBe(true);
    expect(vol.existsSync("/pack.new")).toBe(false);
  });

  it("swaps the completed package into place", async () => {
    vol.fromJSON({ "/pack/old.txt": "old" });
    hoisted.stream.mockReturnValue(responseFor([Buffer.from("archive")]));

    await packManager.downloadPackage();

    expect(vol.existsSync("/pack/old.txt")).toBe(false);
    expect(vol.existsSync("/pack/package/web.pack")).toBe(true);
    expect(vol.existsSync("/pack.new")).toBe(false);
  });
});

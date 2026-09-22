import { describe, expect, it, vi } from "vitest";

import type { Logger } from "pino";

import { PackageDownloadReason } from "@shared/types/package-download";
import {
  ensureWebPack,
  REDOWNLOAD_FLAG,
  type WebPackLoadDeps,
  type WebPackProbe,
} from "@main/services/pack-loader";

const EXPECTED_COMMIT = "aaaaaaaa";

function harness(options: {
  /** Answers `probeWebPack` in order, repeating the last one. */
  probes?: WebPackProbe[];
  offeredCommit?: string | null;
  argv?: string[];
  download?: "ok" | "cancel" | "fail";
}) {
  const {
    probes = [{ status: "ready", commit: EXPECTED_COMMIT }],
    offeredCommit = null,
    argv = [],
    download = "ok",
  } = options;

  const written: string[] = [];
  const offeredReasons: PackageDownloadReason[] = [];
  let probeCount = 0;

  const deps: WebPackLoadDeps = {
    logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
    expectedCommit: EXPECTED_COMMIT,
    argv,
    readOfferedCommit: async () => offeredCommit,
    writeOfferedCommit: async (commit) => {
      written.push(commit);
    },
    probeWebPack: async () => {
      const probe = probes[Math.min(probeCount, probes.length - 1)];
      probeCount += 1;
      return probe;
    },
    requestDownload: async (reason) => {
      offeredReasons.push(reason);
      if (download === "cancel") return Promise.reject("CANCEL");
      if (download === "fail") throw new Error("download broke");
    },
    showDownloadFailure: vi.fn(),
    restartWithout: vi.fn(),
    exit: vi.fn(),
  };

  return {
    deps,
    written,
    offeredReasons,
    probesMade: () => probeCount,
  };
}

describe("ensureWebPack", () => {
  it("returns without offering anything when the pack already matches", async () => {
    const h = harness({});

    await ensureWebPack(h.deps);

    expect(h.offeredReasons).toEqual([]);
    expect(h.written).toEqual([]);
    expect(h.deps.exit).not.toHaveBeenCalled();
  });

  it("offers the download when there is no pack on disk", async () => {
    const h = harness({
      probes: [
        { status: "missing" },
        { status: "ready", commit: EXPECTED_COMMIT },
      ],
    });

    await ensureWebPack(h.deps);

    expect(h.offeredReasons).toEqual([PackageDownloadReason.NotFound]);
  });

  it("calls a corrupt pack a load failure, not a missing one", async () => {
    const h = harness({
      probes: [
        { status: "failed" },
        { status: "ready", commit: EXPECTED_COMMIT },
      ],
    });

    await ensureWebPack(h.deps);

    expect(h.offeredReasons).toEqual([PackageDownloadReason.LoadFailed]);
  });

  it("offers an update when the pack is behind", async () => {
    const h = harness({
      probes: [
        { status: "ready", commit: "bbbbbbbb" },
        { status: "ready", commit: EXPECTED_COMMIT },
      ],
    });

    await ensureWebPack(h.deps);

    expect(h.offeredReasons).toEqual([PackageDownloadReason.UpdateAvailable]);
  });

  it("does not re-offer an update the user already declined", async () => {
    const h = harness({
      probes: [{ status: "ready", commit: "bbbbbbbb" }],
      offeredCommit: EXPECTED_COMMIT,
    });

    await ensureWebPack(h.deps);

    expect(h.offeredReasons).toEqual([]);
  });

  it("records the offered commit so the next launch does not repeat it", async () => {
    const h = harness({
      probes: [
        { status: "ready", commit: "bbbbbbbb" },
        { status: "ready", commit: EXPECTED_COMMIT },
      ],
    });

    await ensureWebPack(h.deps);

    expect(h.written).toEqual([EXPECTED_COMMIT]);
  });

  it("records the offered commit even when the user backs out", async () => {
    const h = harness({
      probes: [{ status: "ready", commit: "bbbbbbbb" }],
      download: "cancel",
    });

    await ensureWebPack(h.deps);

    expect(h.written).toEqual([EXPECTED_COMMIT]);
  });

  it("does not probe the disk for a forced redownload", async () => {
    const h = harness({ argv: [REDOWNLOAD_FLAG] });

    await ensureWebPack(h.deps);

    expect(h.probesMade()).toBe(0);
    expect(h.offeredReasons).toEqual([PackageDownloadReason.UserRequested]);
    expect(h.deps.restartWithout).toHaveBeenCalledWith(REDOWNLOAD_FLAG);
  });

  it("still launches when a forced redownload is cancelled", async () => {
    const h = harness({ argv: [REDOWNLOAD_FLAG], download: "cancel" });

    await ensureWebPack(h.deps);

    expect(h.deps.restartWithout).not.toHaveBeenCalled();
    expect(h.deps.exit).not.toHaveBeenCalled();
    expect(h.probesMade()).toBe(1);
  });

  it("still launches when an update is declined, since the old pack works", async () => {
    const h = harness({
      probes: [{ status: "ready", commit: "bbbbbbbb" }],
      download: "cancel",
    });

    await ensureWebPack(h.deps);

    expect(h.deps.showDownloadFailure).not.toHaveBeenCalled();
    expect(h.deps.exit).not.toHaveBeenCalled();
  });

  it("exits quietly when there is nothing to launch with and the download is declined", async () => {
    const h = harness({ probes: [{ status: "missing" }], download: "cancel" });

    await ensureWebPack(h.deps);

    expect(h.deps.showDownloadFailure).not.toHaveBeenCalled();
    expect(h.deps.exit).toHaveBeenCalledWith(1);
  });

  it("explains itself before exiting when there is no pack to fall back on", async () => {
    const h = harness({ probes: [{ status: "missing" }], download: "fail" });

    await ensureWebPack(h.deps);

    expect(h.deps.showDownloadFailure).toHaveBeenCalledWith(true);
    expect(h.deps.exit).toHaveBeenCalledWith(1);
  });

  it("keeps launching, but says so, when a retryable download breaks", async () => {
    const h = harness({
      probes: [{ status: "ready", commit: "bbbbbbbb" }],
      download: "fail",
    });

    await ensureWebPack(h.deps);

    expect(h.deps.showDownloadFailure).toHaveBeenCalledWith(false);
    expect(h.deps.exit).not.toHaveBeenCalled();
  });
});

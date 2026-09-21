import type { Logger } from "pino";

import { toError } from "@shared/util";
import { PackageDownloadReason } from "$sharedTypes/package-download";

export const REDOWNLOAD_FLAG = "--redownload-package";

/** What the pack manager found on disk. */
export type WebPackProbe =
  | { status: "ready"; commit: string }
  | { status: "missing" }
  | { status: "failed" };

/**
 * Every effect the load loop needs, so the loop itself can be exercised without
 * electron, the filesystem, or a real pack.
 */
export interface WebPackLoadDeps {
  logger: Logger;
  /** `versions.commit` — the commit this build expects the pack to be at. */
  expectedCommit: string;
  argv: string[];

  /** Commit recorded by a previous launch, or `null` when there is no record. Never rejects. */
  readOfferedCommit(): Promise<string | null>;
  /** Records the commit just offered to the user. Never rejects. */
  writeOfferedCommit(commit: string): Promise<void>;

  probeWebPack(): Promise<WebPackProbe>;
  /** Resolves once the pack is installed; rejects with `"CANCEL"` if the user backs out. */
  requestDownload(reason: PackageDownloadReason): Promise<void>;
  /** `noUsablePack` picks between "nothing to launch with" and "retry from the UI". */
  showDownloadFailure(noUsablePack: boolean): void;

  restartWithout(flag: string): void;
  exit(code: number): void;
}

/**
 * Makes sure the pack `versions.json` expects is on disk, offering the download
 * window when it is not. Returns once a usable pack is available; when there is
 * none the app has already exited or restarted.
 */
export async function ensureWebPack(deps: WebPackLoadDeps): Promise<void> {
  let offeredCommit = await deps.readOfferedCommit();
  let forced = deps.argv.includes(REDOWNLOAD_FLAG);

  for (;;) {
    const reason = forced
      ? PackageDownloadReason.UserRequested
      : await downloadReasonFor(deps, offeredCommit);
    if (reason === null) return;

    let cancelled = false;
    let failed = false;
    try {
      await deps.requestDownload(reason);
    } catch (err) {
      cancelled = true;
      if (err !== "CANCEL") {
        failed = true;
        deps.logger.error(
          { name: "loader", err: toError(err) },
          "Failed to download web pack."
        );
      }
    }

    // Remember the commit so we don't offer the download again on the next
    // launch, whether the user downloaded, cancelled, or the download failed.
    offeredCommit = deps.expectedCommit;
    await deps.writeOfferedCommit(offeredCommit);

    if (cancelled) {
      // The download didn't complete (cancelled or failed). If a usable pack
      // is already on disk, keep launching with it; otherwise there is nothing
      // to run with, so exit instead of looping forever.
      const noUsablePack =
        reason === PackageDownloadReason.NotFound ||
        reason === PackageDownloadReason.LoadFailed;
      if (failed) deps.showDownloadFailure(noUsablePack);
      if (noUsablePack) {
        deps.exit(1);
        return;
      }
      if (forced) {
        // Cancelled or failed the forced redownload — drop the flag and use the
        // pack that is already on disk.
        forced = false;
        continue;
      }
      // The loaded (even if mismatched) pack is usable; keep launching.
      return;
    }

    if (forced) {
      // Download succeeded, restart cleanly without the flag.
      deps.restartWithout(REDOWNLOAD_FLAG);
      return;
    }
    // Loop to load the freshly downloaded web pack
  }
}

async function downloadReasonFor(
  deps: WebPackLoadDeps,
  offeredCommit: string | null
): Promise<PackageDownloadReason | null> {
  const probe = await deps.probeWebPack();

  switch (probe.status) {
    case "ready":
      // Offer the update when the installed pack doesn't match the commit
      // versions.json expects, but only once per commit — once the user has
      // been offered it (or cancelled), don't nag again.
      return probe.commit !== deps.expectedCommit &&
        offeredCommit !== deps.expectedCommit
        ? PackageDownloadReason.UpdateAvailable
        : null;
    case "missing":
      return PackageDownloadReason.NotFound;
    case "failed":
      return PackageDownloadReason.LoadFailed;
  }
}

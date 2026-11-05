import path from "node:path";

import type { BrowserWindowConstructorOptions } from "electron";

import packManager from "../pack";
import { PackageDownloadReason } from "@shared/types/package-download";
import { ManagedWindow } from "../window";
import { sendIfAlive } from "../util/send";
import { toError } from "@shared/util";

const packageDownloadWindowOptions = {
  width: 1000,
  height: 600,
  title: "Open Orpheus",
  show: true,
  frame: true,
  webPreferences: {
    partition: "open-orpheus",
    preload: path.join(import.meta.dirname, "package-download.cjs"),
  },
} satisfies BrowserWindowConstructorOptions;

class PackageDownloadWindow extends ManagedWindow {
  private readonly downloadReason: PackageDownloadReason;

  constructor(downloadReason: PackageDownloadReason) {
    super();
    this.downloadReason = downloadReason;
    this.createBrowserWindow({
      ...packageDownloadWindowOptions,
      webPreferences: {
        ...packageDownloadWindowOptions.webPreferences,
        additionalArguments: [`--download-reason=${downloadReason.toString()}`],
      },
    });
    this.hideMenuBar();
    this.loadGuiRoute("/package-download");
  }

  /**
   * Resolves when the package finishes downloading, rejects with `"CANCEL"`
   * when the window is closed early.
   */
  show(): Promise<void> {
    const wnd = this.window;
    if (!wnd) {
      LOGGER.error(
        { downloadReason: PackageDownloadReason[this.downloadReason] },
        "Package download window was not created"
      );
      return Promise.reject(new Error("Package download window was not created"));
    }

    const reasonName = PackageDownloadReason[this.downloadReason];
    const noUsablePack =
      this.downloadReason === PackageDownloadReason.NotFound ||
      this.downloadReason === PackageDownloadReason.LoadFailed;

    return new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      let downloadSuccess = false;
      let downloadFailed = false;
      let lastProgressStep: string | undefined;
      wnd.webContents.ipc.on("download-package", () => {
        LOGGER.info({ downloadReason: reasonName }, "Package download started");
        packManager
          .downloadPackage((progress) => {
            sendIfAlive(wnd, "download-package-progress", progress);
            if (progress.step !== lastProgressStep) {
              lastProgressStep = progress.step;
              if (progress.step === "completed") {
                LOGGER.info({ downloadReason: reasonName }, "Package download completed");
              } else {
                LOGGER.debug(
                  {
                    step: progress.step,
                    downloadedBytes: progress.downloadedBytes,
                    totalBytes: progress.totalBytes,
                  },
                  "Package download progressed"
                );
              }
            }
            if (progress.step === "completed") {
              downloadSuccess = true;
              resolve();
              wnd.close();
            }
          }, controller.signal)
          .catch((e) => {
            // Closing the window aborts the download; the `closed` handler has
            // already rejected with "CANCEL", so this is not a failure.
            if (controller.signal.aborted) return;
            downloadFailed = true;
            if (noUsablePack) {
              LOGGER.fatal(
                { err: toError(e), downloadReason: reasonName },
                "No usable web pack and package download failed; exiting"
              );
            } else {
              LOGGER.error(
                { err: toError(e), downloadReason: reasonName },
                "Failed to download package"
              );
            }
            reject(e);
            wnd.close();
          });
      });
      wnd.on("closed", () => {
        controller.abort();
        if (downloadSuccess || downloadFailed) return;
        if (noUsablePack) {
          LOGGER.fatal(
            { downloadReason: reasonName },
            "No usable web pack and package download was cancelled; exiting"
          );
        } else {
          LOGGER.info({ downloadReason: reasonName }, "Package download cancelled");
        }
        reject("CANCEL");
      });
    });
  }
}

export default function showPackgeDownloadWindow(
  downloadReason = PackageDownloadReason.LoadFailed
): Promise<void> {
  LOGGER.info(
    { downloadReason: PackageDownloadReason[downloadReason] },
    "Showing package download window"
  );
  return new PackageDownloadWindow(downloadReason).show();
}

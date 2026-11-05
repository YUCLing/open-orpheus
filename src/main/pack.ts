import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import got from "got";
import Emittery from "emittery";

import { pack as base } from "./folders";
import type Pack from "./packs/Pack";
import { isFileNotFound } from "./util/fs";

import versions from "../../versions.json";

export const NO_WEBPACK_ERROR_MESSAGE = "No usable web pack file found";

async function chooseWebPackFile() {
  const webPack = resolve(base, "package", "web.pack");
  try {
    await access(webPack);
    return webPack;
  } catch {
    /* empty */
  }
  const orpheusPack = resolve(base, "package", "orpheus.ntpk");
  try {
    await access(orpheusPack);
    return orpheusPack;
  } catch {
    /* empty */
  }
  throw new Error(NO_WEBPACK_ERROR_MESSAGE);
}

export type DownloadPackageProgress = {
  step: "downloading" | "extracting" | "saving" | "completed";
  downloadedBytes?: number;
  totalBytes?: number;
  progress?: number;
  file?: string;
  fileIndex?: number;
  fileCount?: number;
};

export type PackManagerEvents = Record<
  `${string}packloaded`,
  {
    name: string;
    pack: Pack;
    file?: string;
  }
>;

export class PackManager extends Emittery<PackManagerEvents> {
  readonly packs: Map<string, Pack> = new Map();

  async loadWebPack() {
    const webPackPath = await chooseWebPackFile();
    LOGGER.debug({ path: webPackPath }, "Selected web pack file");
    const WebPack = await import("./packs/WebPack").then((m) => m.default);
    const wp = new WebPack(webPackPath);
    await wp.readPack();
    this.packs.set("web", wp);
    LOGGER.info({ file: webPackPath, entries: wp.fileList.length }, "Web pack loaded");
    void this.emit("webpackloaded", { name: "web", pack: wp });
  }

  async loadSkinPack(name: string, name2: string) {
    const SkinPack = await import("./packs/SkinPack").then((m) => m.default);
    const loadOne = async (packKey: "skin" | "skin2", packName: string) => {
      const skinPackPath = resolve(base, "package", `${packName}.skin`);
      try {
        await access(skinPackPath);
      } catch (err) {
        throw new Error(`Cannot load skin pack: ${skinPackPath}`, {
          cause: err,
        });
      }
      const skinPack = new SkinPack(skinPackPath);
      await skinPack.readPack();
      this.packs.set(packKey, skinPack);
      void this.emit(`${packKey}packloaded`, {
        name: packKey,
        pack: skinPack,
        file: `${packName}.skin`,
      });
    };

    await loadOne("skin", name);
    await loadOne("skin2", name2);
    LOGGER.info({ packs: [name, name2] }, "Skin packs loaded");
  }

  getPack<T extends Pack>(pack: string): T {
    const p = this.packs.get(pack);
    if (!p) {
      throw new Error(`Pack not loaded: ${pack}`);
    }
    return p as T;
  }

  async getOrWaitPack<T extends Pack>(pack: string, signal?: AbortSignal): Promise<T> {
    const p = this.packs.get(pack);
    if (p?.isLoaded) {
      return p as T;
    }
    return (await this.once(`${pack}packloaded`, { signal })).data.pack as T;
  }

  async downloadPackage(
    onProgress?: (progress: DownloadPackageProgress) => void,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    LOGGER.debug("Downloading web pack");
    onProgress?.({
      step: "downloading",
      downloadedBytes: 0,
      progress: 0,
    });

    const response = got.stream(versions.downloadUrl, {
      throwHttpErrors: false,
      signal,
    });

    let totalBytes: number | undefined;

    response.once("response", (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        response.destroy(new Error(`Failed to download web pack: ${res.statusMessage}`));
      }
      const contentLength = res.headers["content-length"];
      totalBytes = contentLength ? Number.parseInt(contentLength, 10) : undefined;
    });

    const chunks: Uint8Array[] = [];
    let downloadedBytes = 0;
    for await (const chunk of response) {
      signal?.throwIfAborted();
      const data = chunk as Uint8Array;
      chunks.push(data);
      downloadedBytes += data.byteLength;
      onProgress?.({
        step: "downloading",
        downloadedBytes,
        totalBytes,
        progress: totalBytes ? downloadedBytes / totalBytes : undefined,
      });
    }
    signal?.throwIfAborted();

    const buf = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      downloadedBytes
    );
    LOGGER.info({ bytes: downloadedBytes, totalBytes }, "Web pack downloaded");

    const stdoutBytes: number[] = [];
    const sevenZip = await import("7z-wasm").then((m) =>
      m.default({
        stdout(charCode) {
          stdoutBytes.push(charCode);
        },
      })
    );

    const stream = sevenZip.FS.open("installer.exe", "w+");
    sevenZip.FS.write(stream, buf, 0, buf.length);
    sevenZip.FS.close(stream);

    sevenZip.callMain(["l", "installer.exe"]);
    const stdout = new TextDecoder().decode(new Uint8Array(stdoutBytes));
    const lines = stdout.split("\n");
    const headerIdx = lines.findIndex((l) => /\sName\s*$/.test(l));
    const start = headerIdx + 2;
    const end = lines.findIndex((l, i) => i > start && /^-{3,}/.test(l));

    const fileList: string[] = lines
      .slice(start, end)
      .map((l) => l.trim().split(/\s+/).pop()!)
      .filter(Boolean);

    signal?.throwIfAborted();
    onProgress?.({ step: "extracting" });

    const filesToExtract = fileList.filter(
      (v) => v.startsWith("resource/") || v.startsWith("package/")
    );
    if (filesToExtract.length === 0) {
      LOGGER.warn({ entries: fileList.length }, "Web pack archive contained no package files");
    }

    sevenZip.callMain(["x", "installer.exe", ...filesToExtract]);
    signal?.throwIfAborted();

    onProgress?.({
      step: "saving",
      fileCount: filesToExtract.length,
      fileIndex: 0,
    });

    // Write into a sibling directory first. The live package is only replaced
    // after every file is in place and the download has not been cancelled, so
    // an aborted update can never leave a half-installed package behind.
    const staging = `${base}.new`;
    await rm(staging, { recursive: true, force: true });
    try {
      for (const [index, file] of filesToExtract.entries()) {
        signal?.throwIfAborted();
        const destPath = resolve(staging, file);
        const buf = sevenZip.FS.readFile(file);
        await mkdir(dirname(destPath), { recursive: true }); // Ensure the directory exists
        await writeFile(destPath, buf);
        onProgress?.({
          step: "saving",
          file,
          fileCount: filesToExtract.length,
          fileIndex: index + 1,
          progress: (index + 1) / filesToExtract.length,
        });
      }

      signal?.throwIfAborted();
      await replacePackageDirectory(staging, base);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    onProgress?.({ step: "completed", progress: 1 });
    LOGGER.info({ files: filesToExtract.length }, "Web pack installed");
  }
}

/**
 * Swap a fully-written staging directory into place, keeping the old package
 * as a backup until the new one has been moved in.
 */
async function replacePackageDirectory(staging: string, target: string) {
  const backup = `${target}.old`;
  await rm(backup, { recursive: true, force: true });

  let hadTarget = true;
  try {
    await rename(target, backup);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
    hadTarget = false;
  }

  try {
    await rename(staging, target);
  } catch (error) {
    if (hadTarget) {
      await rename(backup, target).catch(() => {});
    }
    throw error;
  }

  if (hadTarget) {
    await rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

const packManager = new PackManager();
export default packManager;

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import got from "got";
import Emittery from "emittery";

import { pack as base } from "./folders";
import type Pack from "./packs/Pack";

import versions from "../../versions.json";

function chooseWebPackFile() {
  const webPack = resolve(base, "package", "web.pack");
  if (existsSync(webPack)) {
    return webPack;
  }
  const orpheusPack = resolve(base, "package", "orpheus.ntpk");
  if (existsSync(orpheusPack)) {
    return orpheusPack;
  }
  throw new Error("No pack file found");
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
    const webPackPath = chooseWebPackFile();
    const WebPack = await import("./packs/WebPack").then((m) => m.default);
    const wp = new WebPack(webPackPath);
    await wp.readPack();
    this.packs.set("web", wp);
    this.emit("webpackloaded", { name: "web", pack: wp });
  }

  async loadSkinPack(name: string, name2: string) {
    const SkinPack = await import("./packs/SkinPack").then((m) => m.default);
    const loadOne = async (packKey: "skin" | "skin2", packName: string) => {
      const skinPackPath = resolve(base, "package", `${packName}.skin`);
      if (!existsSync(skinPackPath)) {
        throw new Error(`Skin pack file not found: ${skinPackPath}`);
      }
      const skinPack = new SkinPack(skinPackPath);
      await skinPack.readPack();
      this.packs.set(packKey, skinPack);
      this.emit(`${packKey}packloaded`, {
        name: packKey,
        pack: skinPack,
        file: `${packName}.skin`,
      });
    };

    await loadOne("skin", name);
    await loadOne("skin2", name2);
  }

  getPack<T extends Pack>(pack: string): T {
    const p = this.packs.get(pack);
    if (!p) {
      throw new Error(`Pack not loaded: ${pack}`);
    }
    return p as T;
  }

  async getOrWaitPack<T extends Pack>(pack: string): Promise<T> {
    const p = this.packs.get(pack);
    if (p?.isLoaded) {
      return p as T;
    }
    return (await this.once(`${pack}packloaded`)).data.pack as T;
  }

  async downloadPackage(
    onProgress?: (progress: DownloadPackageProgress) => void
  ) {
    onProgress?.({
      step: "downloading",
      downloadedBytes: 0,
      progress: 0,
    });

    const response = got.stream(versions.downloadUrl, {
      throwHttpErrors: false,
    });

    let totalBytes: number | undefined;

    response.once("response", (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        response.destroy(
          new Error(`Failed to download web pack: ${res.statusMessage}`)
        );
      }
      const contentLength = res.headers["content-length"];
      totalBytes = contentLength
        ? Number.parseInt(contentLength, 10)
        : undefined;
    });

    const chunks: Uint8Array[] = [];
    let downloadedBytes = 0;
    for await (const chunk of response) {
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

    const buf = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      downloadedBytes
    );

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

    onProgress?.({ step: "extracting" });

    const filesToExtract = fileList.filter(
      (v) => v.startsWith("resource/") || v.startsWith("package/")
    );

    sevenZip.callMain(["x", "installer.exe", ...filesToExtract]);

    onProgress?.({
      step: "saving",
      fileCount: filesToExtract.length,
      fileIndex: 0,
    });

    try {
      // We want no leftovers
      await rm(base, { recursive: true, force: true });
    } catch {
      /* If fails, that's okay */
    }

    for (const [index, file] of filesToExtract.entries()) {
      const destPath = resolve(base, file);
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

    onProgress?.({ step: "completed", progress: 1 });
  }
}

const packManager = new PackManager();
export default packManager;

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import SevenZip from "7z-wasm";

import { pack as base } from "./folders";
import WebPack from "./packs/WebPack";
import SkinPack from "./packs/SkinPack";
//import { fetchUpgradeInfo } from "./update";

function chooseWebPackFile() {
  const webPack = resolve(base, "web.pack");
  if (existsSync(webPack)) {
    return webPack;
  }
  const orpheusPack = resolve(base, "orpheus.ntpk");
  if (existsSync(orpheusPack)) {
    return orpheusPack;
  }
  throw new Error("No pack file found");
}

export let webPack: WebPack | null = null;
export let skinPack: SkinPack | null = null;

export type DownloadPackageProgress = {
  step: "downloading" | "extracting" | "saving" | "completed";
  downloadedBytes?: number;
  totalBytes?: number;
  progress?: number;
  file?: string;
  fileIndex?: number;
  fileCount?: number;
};

export async function loadWebPack() {
  const webPackPath = chooseWebPackFile();
  webPack = new WebPack(webPackPath);
  await webPack.readPack();
}

export async function loadSkinPack(name: string) {
  const skinPackPath = resolve(base, `${name}.skin`);
  if (!existsSync(skinPackPath)) {
    throw new Error(`Skin pack file not found: ${skinPackPath}`);
  }
  skinPack = new SkinPack(skinPackPath);
  await skinPack.readPack();
}

export function getSkinPack() {
  if (!skinPack) {
    throw new Error("Skin pack not loaded");
  }
  return skinPack;
}

export async function downloadPackage(
  onProgress?: (progress: DownloadPackageProgress) => void
) {
  const files = ["common.skin", "dark.skin", "native.ntpk", "orpheus.ntpk"];

  /*const upgradeInfo = await fetchUpgradeInfo();
  if (upgradeInfo.code !== 200) {
    throw new Error(`Failed to fetch upgrade info: ${upgradeInfo.message}`);
  }
  const downloadUrl = upgradeInfo.data.packageVO.downloadUrl;
  */
  // TODO: NetEase doesn't seem to willing to return download url, hardcode it for now
  // https://d8.music.126.net/dmusic2/NeteaseCloudMusic_Music_official_3.1.29.205117_64.exe
  // https://d8.music.126.net/dmusic2/NeteaseCloudMusic_Music_BS_84539_3.1.28.205001_3.1.29.205117_netease_64.exe

  // TODO: Actually, maybe we should use fixed URL, since we are only targeting one specific version at a time.

  const downloadUrl =
    "https://d8.music.126.net/dmusic2/NeteaseCloudMusic_Music_official_3.1.29.205117_64.exe";

  onProgress?.({
    step: "downloading",
    downloadedBytes: 0,
    progress: 0,
  });

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download web pack: ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength
    ? Number.parseInt(contentLength, 10)
    : undefined;

  let buf: Buffer;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let downloadedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      chunks.push(value);
      downloadedBytes += value.byteLength;
      onProgress?.({
        step: "downloading",
        downloadedBytes,
        totalBytes,
        progress: totalBytes ? downloadedBytes / totalBytes : undefined,
      });
    }

    buf = Buffer.concat(chunks, downloadedBytes);
  } else {
    const arrayBuffer = await response.arrayBuffer();
    buf = Buffer.from(arrayBuffer);
    onProgress?.({
      step: "downloading",
      downloadedBytes: buf.length,
      totalBytes,
      progress: totalBytes ? buf.length / totalBytes : 1,
    });
  }

  const sevenZip = await SevenZip();

  const stream = sevenZip.FS.open("installer.exe", "w+");
  sevenZip.FS.write(stream, buf, 0, buf.length);
  sevenZip.FS.close(stream);

  onProgress?.({ step: "extracting" });

  sevenZip.callMain([
    "x",
    "installer.exe",
    ...files.map((f) => `package/${f}`),
  ]);

  onProgress?.({
    step: "saving",
    fileCount: files.length,
    fileIndex: 0,
  });

  await mkdir(base, { recursive: true }); // Ensure the base directory exists

  for (const [index, file] of files.entries()) {
    const destPath = resolve(base, file);
    const buf = sevenZip.FS.readFile(`package/${file}`);
    await writeFile(destPath, buf);
    onProgress?.({
      step: "saving",
      file,
      fileCount: files.length,
      fileIndex: index + 1,
      progress: (index + 1) / files.length,
    });
  }

  onProgress?.({ step: "completed", progress: 1 });
}

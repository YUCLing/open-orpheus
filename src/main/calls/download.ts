import { cp, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { registerCallHandler } from "../calls";
import startDownload, { type DownloadTask } from "../download";
import { data as dataDir, downloadTemp } from "../folders";
import { normalizePath, sanitizeRelativePath } from "../util";

type DownloadStartRequest = {
  ext_header: string;
  id: string;
  md5?: string;
  md5_check_fail: number; // 0 or 1?
  mediaType: number;
  pre_path: string;
  rel_path: string;
  size: number;
  url: string;
  type?: number;
};

// Payload of `download.onprocess`
/* type DownloadProcessPayload = {
  down: number; // Downloaded bytes
  islast: boolean; // Is the last progress update
  path: string; // Local file path
  relative: string; // Relative path from the download request
  speed: number; // Download speed in bytes/sec
  total: number; // Total bytes to download
  type: number;
}; */

const downloadTasks = new Map<string, DownloadTask>();

registerCallHandler<[DownloadStartRequest], void>(
  "download.start",
  async (event, request: DownloadStartRequest) => {
    const {
      ext_header,
      id,
      md5,
      //md5_check_fail,
      //mediaType,
      //pre_path,
      rel_path,
      size,
      url,
      type = 0,
    } = request;

    // Parse headers from JSON string
    let headers: Record<string, string> = {};
    if (ext_header) {
      try {
        headers = JSON.parse(ext_header);
      } catch (error) {
        console.error("Failed to parse ext_header JSON:", error);
      }
    }

    // Construct destination path: tmpdir + rel_path
    const destPath = normalizePath(downloadTemp, rel_path);

    const task = await startDownload(url, destPath, {
      headers,
      md5,
      size,
    });

    task.on("progress", (e) => {
      event.sender.send("channel.call", "download.onprocess", id, {
        down: e.data.downloaded,
        islast: false,
        path: destPath,
        relative: rel_path,
        speed: e.data.speed,
        total: e.data.total || size,
        type,
      });
    });

    task.on("end", async (e) => {
      if (type === 2) {
        // Audio effect, ...?
        const finalPath = sanitizeRelativePath(dataDir, rel_path);
        if (finalPath === false) {
          // Trigger task error
          throw new Error("Illegal path: " + rel_path);
        }
        await mkdir(dirname(finalPath), { recursive: true });
        await cp(destPath, finalPath);
        await rm(destPath);
      }

      event.sender.send("channel.call", "download.onprocess", id, {
        down: e.data.downloaded,
        islast: true,
        path: destPath,
        relative: rel_path,
        speed: e.data.speed,
        total: e.data.total || size,
        type,
      });

      downloadTasks.delete(id);
    });

    task.on("error", (e) => {
      console.error(`Download error for id ${id}:`, e.data);
      event.sender.send("channel.call", "download.onprocess", id, {
        down: 0,
        islast: true,
        path: destPath,
        relative: rel_path,
        speed: 0,
        total: size,
        type,
      });
      downloadTasks.delete(id);
    });

    downloadTasks.set(id, task);
  }
);

registerCallHandler<[string], void>(
  "download.pause",
  async (event, id: string) => {
    const task = downloadTasks.get(id);
    if (task) {
      task.pause();
    }
  }
);

registerCallHandler<[string], void>(
  "download.resume",
  async (event, id: string) => {
    const task = downloadTasks.get(id);
    if (task) {
      task.resume();
    }
  }
);

registerCallHandler<[string], void>(
  "download.cancel",
  async (event, id: string) => {
    const task = downloadTasks.get(id);
    if (task) {
      await task.cancel();
      downloadTasks.delete(id);
    }
  }
);

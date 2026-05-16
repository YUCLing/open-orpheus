import { getCallLogger, registerCallHandler } from "../calls";
import startDownload, {
  type DownloadTask,
  type ProgressEvent,
  type EndEvent,
  type ErrorEvent,
} from "../download";
import { downloadTemp } from "../folders";
import { normalizePath } from "../util";

const logger = getCallLogger("download");

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
    } = request;

    // Parse headers from JSON string
    let headers: Record<string, string> = {};
    if (ext_header) {
      try {
        headers = JSON.parse(ext_header);
      } catch (error) {
        logger.error(
          { call: "start", json: ext_header },
          "Failed to parse ext_header: %s",
          error
        );
      }
    }

    // Construct destination path: tmpdir + rel_path
    const destPath = normalizePath(downloadTemp, rel_path);

    const task = await startDownload(url, destPath, {
      headers,
      md5,
      size,
    });

    task.addEventListener("progress", ((e: ProgressEvent) => {
      event.sender.send("channel.call", "download.onprocess", id, {
        down: e.detail.downloaded,
        islast: false,
        path: destPath,
        relative: rel_path,
        speed: e.detail.speed,
        total: e.detail.total || size,
        type: 0,
      });
    }) as EventListener);

    task.addEventListener("end", ((e: EndEvent) => {
      event.sender.send("channel.call", "download.onprocess", id, {
        down: e.detail.downloaded,
        islast: true,
        path: destPath,
        relative: rel_path,
        speed: e.detail.speed,
        total: e.detail.total || size,
        type: 0,
      });
      downloadTasks.delete(id);
    }) as EventListener);

    task.addEventListener("error", ((e: ErrorEvent) => {
      logger.error({ call: "start", err: e.detail.error }, "Download errored");
      event.sender.send("channel.call", "download.onprocess", id, {
        down: 0,
        islast: true,
        path: destPath,
        relative: rel_path,
        speed: 0,
        total: size,
        type: 1,
      });
      downloadTasks.delete(id);
    }) as EventListener);

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

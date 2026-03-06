import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { data as dataDir } from "../folders";
import { registerCallHandler } from "../calls";
import { sanitizeRelativePath } from "../util";
import { getWebDb } from "../database";
import { existsSync, mkdirSync } from "node:fs";

registerCallHandler<[string, string, string], [string, string]>(
  "storage.init",
  (event, downloadDir, someNumStr, cacheDir) => {
    if (!downloadDir) {
      // TODO: find proper download dir
      downloadDir = resolve(join(dataDir, "downloads"));
    }
    if (!cacheDir) {
      cacheDir = resolve(join(dataDir, "cache"));
    }
    mkdirSync(downloadDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    return [downloadDir, cacheDir];
  }
);

registerCallHandler<[string, string, boolean, string], void>(
  "storage.readfromfile",
  async (event, taskId, path) => {
    const filePath = sanitizeRelativePath(dataDir, path);
    if (filePath === false) {
      throw new Error(`Forbidden file path access attempt: ${path}`);
    }
    try {
      const fileContent = await readFile(filePath);
      event.sender.send(
        "channel.call",
        "storage.onreadfromfiledone",
        taskId,
        0,
        fileContent.toString("utf-8")
      );
    } catch (error) {
      // -2: Not Found
      event.sender.send(
        "channel.call",
        "storage.onreadfromfiledone",
        taskId,
        -2
      );
    }
  }
);

registerCallHandler<[string, string], void>(
  "storage.execsql",
  async (event, taskId, sql) => {
    try {
      const execResult = getWebDb().executeSql(sql);
      event.sender.send(
        "channel.call",
        "storage.onexecsqldone",
        taskId,
        ...execResult
      );
    } catch (error) {
      console.error(`Error executing SQL: ${error.message}`);
      event.sender.send(
        "channel.call",
        "storage.onexecsqldone",
        taskId,
        1,
        undefined,
        [0, 0, 0]
      );
    }
  }
);

registerCallHandler<[string, string], void>(
  "storage.exectransaction",
  async (event, taskId, sql) => {
    try {
      const execResult = getWebDb().executeTransaction(sql);
      event.sender.send(
        "channel.call",
        "storage.onexecsqldone",
        taskId,
        ...execResult
      );
    } catch (error) {
      console.error(`Error executing SQL transaction: ${error.message}`);
      event.sender.send(
        "channel.call",
        "storage.onexecsqldone",
        taskId,
        1,
        undefined,
        [0, 0, 0]
      );
    }
  }
);

registerCallHandler<[string, string, string, string, boolean, string], void>(
  "storage.savetofile",
  async (event, taskId, content, mode, path) => {
    const filePath = sanitizeRelativePath(dataDir, path);
    if (filePath === false) {
      throw new Error(`Forbidden file path access attempt: ${path}`);
    }

    await mkdir(dirname(filePath), { recursive: true });

    try {
      await writeFile(filePath, content, { flag: "w" });
      event.sender.send("channel.call", "storage.onsavetofiledone", taskId, 0);
    } catch (error) {
      event.sender.send(
        "channel.call",
        "storage.onsavetofiledone",
        taskId,
        -1,
        error.message
      );
    }
  }
);

registerCallHandler<[string, { id: string; path: string }[], string], void>(
  "storage.checkFilesExist",
  async (event, taskId, files, basePath) => {
    const results = files.map(async (file) => {
      const filePath = join(basePath, file.path);
      return { id: file.id, exists: existsSync(filePath) };
    });
    event.sender.send(
      "channel.call",
      "storage.oncheckfilesexist",
      taskId,
      true,
      results
    );
  }
);

registerCallHandler<[string, boolean, string, number, string[]], void>(
  "storage.downloadscanner",
  (event) => {
    // TODO: Scan download dir for downloaded music
    event.sender.send("channel.send", "storage.ondownloadscanner");
  }
);

// TODO: Track cache
registerCallHandler<
  [],
  {
    bitrate: number;
    cached: number;
    dfsId: "";
    format: "";
    lastAccessTime: number;
    lastModifyTime: number;
    md5: string;
    playInfoExist: boolean;
    playInfoStr: string;
    songId: string;
    volumeGain: number;
  }[]
>("storage.queryCacheTracks", () => []);

registerCallHandler<[string], void>("storage.getTempFile", (event, songId) => {
  // Gets cached lyric response for the song.
  // TODO: Implement proper caching logic and return actual cached response.
  event.sender.send(
    "channel.call",
    "storage.ongettempfile",
    songId,
    404, // 0 for success, 404 for not found
    "" // the response content, empty if not found
  );
});

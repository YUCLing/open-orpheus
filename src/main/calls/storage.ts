import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

import { app } from "electron";
import mime from "mime";
import { MetaPicture, MusicFile } from "music-tag-native";

import {
  data as dataDir,
  defaultCache,
  download,
  downloadTemp,
  setCachePath,
  setDownloadPath,
} from "../folders";
import { registerCallHandler } from "../calls";
import { isMusicFile, normalizePath, sanitizeRelativePath } from "../util";
import { webDb } from "../database";
import {
  CacheTrackMeta,
  type PlayCacheConfig,
  type PlayCacheInfo,
} from "../cache/PlayCacheManager";
import createCacheManager, {
  lyricCacheManager,
  playCacheManager,
} from "../cache";
import { toError } from "../../util";
import { commentToID3Json, ID3JsonToComment } from "../id3";

type DownloadScannerItem = {
  comment: string; // comment added by addid3
  creation_time: number; // timestamp
  last_accessed: number;
  last_modified: number;
  path: string; // path relative to download dir
  size: number;
};

async function readDownloadedMusicInfo(
  file: string,
  base: string | undefined = undefined
): Promise<DownloadScannerItem | undefined> {
  const filePath = normalizePath(base ?? "", file);
  let comment;
  try {
    const taggedFile = await MusicFile.load(filePath);
    const json = commentToID3Json(taggedFile.comment);

    if (!json) return;

    comment = json;
  } catch (error) {
    console.error(`Error reading ID3 tags from ${filePath}:`, error);
    return;
  }
  const statResult = await stat(filePath);
  return {
    comment,
    creation_time: statResult.birthtimeMs,
    last_accessed: statResult.atimeMs,
    last_modified: statResult.mtimeMs,
    path: file,
    size: statResult.size,
  };
}

registerCallHandler<[string, string, string], [string, string]>(
  "storage.init",
  (event, downloadDir, someNumStr, cacheDir) => {
    if (!downloadDir) {
      downloadDir = resolve(app.getPath("downloads"), "CloudMusic");
      if (process.env.FLATPAK_ID) {
        // We store to only writable path in Flatpak
        downloadDir = resolve(
          app.getPath("home"),
          ".var",
          "app",
          process.env.FLATPAK_ID,
          "downloads"
        );
      }
    }
    if (!cacheDir) {
      cacheDir = defaultCache;
    }
    mkdirSync(downloadDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    setDownloadPath(downloadDir);
    setCachePath(cacheDir);
    createCacheManager();

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
    } catch {
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
      const execResult = webDb.executeSql(sql);
      event.sender.send(
        "channel.call",
        "storage.onexecsqldone",
        taskId,
        ...execResult
      );
    } catch (error) {
      console.error(`Error executing SQL:`, error);
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
      const execResult = webDb.executeTransaction(sql);
      event.sender.send(
        "channel.call",
        "storage.onexecsqldone",
        taskId,
        ...execResult
      );
    } catch (error) {
      console.error(`Error executing SQL transaction:`, error);
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

registerCallHandler<
  [string, string, string, string, boolean, "abs" | "rel"],
  void
>(
  "storage.savetofile",
  async (event, taskId, content, mode, path, alone, type) => {
    let filePath: string;
    if (type === "rel") {
      const p = sanitizeRelativePath(dataDir, path);
      if (p === false) {
        throw new Error(`Forbidden file path access attempt: ${path}`);
      }
      filePath = p;
    } else {
      filePath = normalizePath(path);
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
        toError(error).message
      );
    }
  }
);

registerCallHandler<[string, "abs" | "rel", "", string, boolean], void>(
  "storage.deletefile",
  async (event, taskId, type, emptyStr, path /* , deleteEmptyDir */) => {
    let filePath: string;
    if (type === "rel") {
      const p = sanitizeRelativePath(dataDir, path);
      if (p === false) {
        throw new Error(`Forbidden file path access attempt: ${path}`);
      }
      filePath = p;
    } else {
      filePath = normalizePath(path);
    }

    if (!existsSync(filePath)) {
      event.sender.send(
        "channel.call",
        "storage.ondeletefilesdone",
        taskId,
        1,
        undefined
      );
      return;
    }

    try {
      await rm(filePath);
      event.sender.send(
        "channel.call",
        "storage.ondeletefilesdone",
        taskId,
        0,
        [filePath]
      );
    } catch (err) {
      console.error("Failed to delete file", err);
      event.sender.send(
        "channel.call",
        "storage.ondeletefilesdone",
        taskId,
        2,
        undefined
      );
    }
  }
);

registerCallHandler<[string, { id: string; path: string }[], string], void>(
  "storage.checkFilesExist",
  async (event, taskId, files, basePath) => {
    const results = await Promise.all(
      files.map(async (file) => {
        const filePath = normalizePath(basePath, file.path);
        return { id: file.id, exists: existsSync(filePath) };
      })
    );
    event.sender.send(
      "channel.call",
      "storage.oncheckfilesexist",
      taskId,
      true,
      results
    );
  }
);

// Fires `storage.ondownloadscanner` progressively with batches of
// `DownloadScannerItem[]` up to `limit` items per batch.
registerCallHandler<[string, boolean, string, number, string[]], void>(
  "storage.downloadscanner",
  (event, path, recursive, emptyStr, limit, excludes) => {
    (async () => {
      path = normalizePath(path);
      const excludeSet = new Set(excludes.map((p) => normalizePath(path, p)));
      const batch: DownloadScannerItem[] = [];

      const entries = await readdir(path, {
        recursive: true,
        withFileTypes: true,
      });

      const flush = () => {
        if (batch.length > 0) {
          event.sender.send(
            "channel.call",
            "storage.ondownloadscanner",
            batch.splice(0)
          );
        }
      };

      try {
        for (const entry of entries) {
          if (entry.isDirectory()) {
            continue;
          }

          if (!isMusicFile(entry.name)) continue;

          const fullPath = normalizePath(entry.parentPath, entry.name);
          if (excludeSet.has(fullPath)) continue;

          const relToBase = fullPath.slice(path.length + 1);
          const info = await readDownloadedMusicInfo(relToBase, path);
          if (!info) continue;

          batch.push(info);
          if (batch.length >= limit) flush();
        }

        flush();
      } catch (err) {
        console.error(`DownloadScanner: scanner path ${path}:`, err);
      }
    })();
  }
);

registerCallHandler<[], void>("storage.queryCacheTracks", async (event) => {
  if (!playCacheManager) return;
  const wnd = event.sender;
  if (!wnd) return;
  const tracks = await playCacheManager.queryCacheTracks();
  wnd.send("channel.call", "storage.onquerycachetracks", tracks);
  return;
});

registerCallHandler<
  [
    {
      trackId: string;
      bitrate: number;
      md5: string;
    },
  ],
  [CacheTrackMeta | null]
>("storage.queryNewCacheTrack", async (event, track) => {
  if (!playCacheManager) return [null];
  const wnd = event.sender;
  if (!wnd) return [null];
  const cachedTrack = await playCacheManager.getCachedTrack(track.trackId);
  if (
    !cachedTrack ||
    track.bitrate !== cachedTrack.meta.bitrate ||
    (track.md5 && track.md5 !== cachedTrack.meta.md5)
  )
    return [null];
  return [cachedTrack.meta];
});

registerCallHandler<[PlayCacheConfig], void>(
  "storage.setPlayCacheConfig",
  (event, config) => {
    playCacheManager?.setConfig(config);
  }
);

registerCallHandler<[], [PlayCacheInfo | undefined]>(
  "storage.playCacheInfo",
  async () => {
    const info = await playCacheManager?.getInfo();
    return [info];
  }
);

registerCallHandler<[""], [boolean]>("storage.clearCache", async () => {
  if (!playCacheManager) return [false];
  try {
    await playCacheManager.clearAll();
    return [true];
  } catch {
    return [false];
  }
});

registerCallHandler<[string], void>(
  "storage.getTempFile",
  async (event, songId) => {
    let content = "";
    try {
      content = (await lyricCacheManager?.get(songId)) ?? "";
    } catch (error) {
      console.error(`Error reading temp file for songId ${songId}:`, error);
    }
    event.sender.send(
      "channel.call",
      "storage.ongettempfile",
      songId,
      content ? 0 : 404,
      content
    );
  }
);

registerCallHandler<[string, string, string], void>(
  "storage.updatetemp",
  async (event, songId, content, type) => {
    if (!lyricCacheManager) return;

    if (type !== "text/plain") {
      console.error(`Unsupported temp file type: ${type}`);
      return;
    }

    try {
      await lyricCacheManager.set(songId, content);
    } catch (error) {
      console.error(`Error writing temp file for songId ${songId}:`, error);
    }
  }
);

registerCallHandler<[string], [boolean]>(
  "storage.testwriteable",
  async (event, path) => {
    const testFilePath = join(path, "open_orpheus_test_writable.tmp");
    try {
      await writeFile(testFilePath, "test", { flag: "w" });
      await unlink(testFilePath);
      return [true];
    } catch {
      return [false];
    }
  }
);

registerCallHandler<[string, "abs" | "rel", "", string], void>(
  "storage.listFile",
  (event, taskId, type, emptyStr, path) => {
    let filePath: string;
    if (type === "rel") {
      const p = sanitizeRelativePath(dataDir, path);
      if (p === false) {
        throw new Error(`Forbidden file path access attempt: ${path}`);
      }
      filePath = p;
    } else {
      filePath = path;
    }
    readdir(filePath, { withFileTypes: true })
      .then((dirents) => {
        const files = dirents.map((dirent) => ({
          name: dirent.name,
          path: join(filePath, dirent.name),
          type: dirent.isDirectory() ? "directory" : "file",
        }));
        event.sender.send(
          "channel.call",
          "storage.onlistfile",
          taskId,
          0,
          files
        );
      })
      .catch((error) => {
        console.error(`Error listing files in ${filePath}: ${error.message}`);
        // TODO: Some error code?
        event.sender.send("channel.call", "storage.onlistfile", taskId, 1, []);
      });
  }
);

type AddId3Request = {
  encrypt: boolean; // Should use .ncm format
  image_rel_path: string;
  media_rel_path: string;
  talb: string; // Track album
  tit2: string; // Track title
  tpe1: string | string[]; // Track artists, an array if podcast
  tpos: string; // Disc number
  trck: string; // Track pos
};
// `mediaInfo` is saved to comment, with encryption (enData using its own key), prefixed with `163 key(Don't modify):`
// Reply with `storage.onaddid3done`
// - taskId
// - code? 1
// - final media path relative to download path
registerCallHandler<[string, string, string, string, AddId3Request], void>(
  "storage.addid3",
  (event, taskId, mediaPath, imagePath, mediaInfo, id3Info) => {
    // Don't block the call.
    (async () => {
      mediaPath = normalizePath(mediaPath);

      const file = await MusicFile.load(mediaPath);

      file.album = id3Info.talb;
      file.title = id3Info.tit2;
      file.artist =
        typeof id3Info.tpe1 === "string"
          ? id3Info.tpe1
          : id3Info.tpe1.join(",");
      file.discNumber = parseInt(id3Info.tpos) || 0;
      file.trackNumber = parseInt(id3Info.trck) || 0;

      const imageFullPath = normalizePath(downloadTemp, imagePath);
      if (existsSync(imageFullPath)) {
        const mimeType = mime.getType(imageFullPath);
        if (mimeType) {
          const imageData = await readFile(imageFullPath);
          file.pictures = [new MetaPicture(mimeType, imageData)];
        }
      }

      file.comment = ID3JsonToComment(mediaInfo);

      let relPath = id3Info.media_rel_path;
      if (relPath.endsWith(".ncm")) {
        // Current we don't know what's .ncm format, just rename to the original extension
        const originalExt = extname(mediaPath);
        relPath = relPath.slice(0, -4) + originalExt;
      }

      const finalPath = normalizePath(download, relPath);
      await mkdir(dirname(finalPath), { recursive: true });
      await file.save(finalPath);

      await rm(imageFullPath, { force: true });
      await rm(mediaPath, { force: true });

      event.sender.send(
        "channel.call",
        "storage.onaddid3done",
        taskId,
        1,
        relPath
      );
    })().catch((err) => {
      console.error("Failed to write ID3 tag", err);
      event.sender.send("channel.call", "storage.onaddid3done", taskId, 0);
    });
  }
);

async function handleFileBatch(
  type: "copy" | "move",
  event: Electron.IpcMainInvokeEvent,
  srcPaths: string[],
  destPaths: string[]
) {
  if (srcPaths.length !== destPaths.length) {
    console.error("src and dest paths length mismatch");
    return;
  }

  let processedCount = 0;
  let lastSrc: string | null = null;
  let lastDest: string | null = null;

  try {
    await Promise.all(
      srcPaths.map(async (src, index) => {
        src = normalizePath(src);
        const dest = normalizePath(destPaths[index]);
        await mkdir(dirname(dest), { recursive: true });
        if (existsSync(src)) {
          // Simply no-op if source doesn't exist
          if (type === "copy") await copyFile(src, dest);
          else await rename(src, dest);
        }
        processedCount++;
        lastSrc = src;
        lastDest = dest;
        event.sender.send("channel.call", `storage.on${type}process`, {
          code: 0,
          state: srcPaths.length - processedCount,
          errcode: 0,
          remain: srcPaths.length - processedCount,
          process: processedCount / srcPaths.length,
          src,
          dst: dest,
        });
      })
    );
  } catch (error) {
    console.error(`Error when ${type} files:`, error);
    event.sender.send("channel.call", `storage.on${type}process`, {
      code: 1,
      state: srcPaths.length - processedCount,
      errcode: 1,
      remain: 0,
      process: processedCount / srcPaths.length,
      src: lastSrc || "",
      dst: lastDest || "",
    });
    return;
  }
}

registerCallHandler<["copy", "abs", "", string[], "abs", "", string[]], void>(
  "storage.copyfiles",
  async (
    event,
    type,
    srcType,
    emptyStr1,
    srcPaths,
    destType,
    emptyStr2,
    destPaths
  ) => {
    if (type !== "copy" || srcType !== "abs" || destType !== "abs") {
      console.error(
        `Unsupported file operation type: ${type} with srcType: ${srcType} and destType: ${destType}`
      );
      return;
    }

    handleFileBatch("copy", event, srcPaths, destPaths);
  }
);

registerCallHandler<["move", "abs", "", string[], "abs", "", string[]], void>(
  "storage.movefiles",
  async (
    event,
    type,
    srcType,
    emptyStr1,
    srcPaths,
    destType,
    emptyStr2,
    destPaths
  ) => {
    if (type !== "move" || srcType !== "abs" || destType !== "abs") {
      console.error(
        `Unsupported file operation type: ${type} with srcType: ${srcType} and destType: ${destType}`
      );
      return;
    }

    handleFileBatch("move", event, srcPaths, destPaths);
  }
);

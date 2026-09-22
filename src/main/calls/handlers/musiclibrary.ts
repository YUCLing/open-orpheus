import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path, { basename } from "node:path";
import { createHash } from "node:crypto";

import { app } from "electron";
import { MusicFile } from "music-tag-native";
import mime from "mime";

import { registerCallHandler } from "../dispatcher";
import type { DatabaseService } from "../../bootstrap/types";
import {
  fileExists,
  isFileNotFound,
  isMusicFile,
  normalizePath,
} from "../../platform/util";
import { toError } from "@shared/util";
import { commentToID3Metadata } from "../../domain/id3";

type MusicLibraries =
  "<mymusic>" | "<download>" | "<windowsmedia>" | "<itunes>" | string;

type TrackEntry = {
  file: string;
  tid: string;
  aid: string;
  dir: string;
  title: string;
  album: string;
  genre: string;
  artist: string;
  duration: number;
  timestamp: number;
  bitrate: number;
  filesize: number;
  ignored: number;
  id: string;
  artistid: string;
  parentdir: string;
  track: string;
  librarypath: string;
  tracknumber: number;
  source: string;
  starttime: number;
  type: number;
};

function getLibraryPath(library: MusicLibraries): string | null {
  try {
    switch (library) {
      case "<mymusic>":
        return app.getPath("music");
      case "<download>":
        return app.getPath("downloads");
      case "<windowsmedia>":
      case "<itunes>":
        return null;
      default:
        return normalizePath(library);
    }
  } catch {
    return null;
  }
}

function generateTrackId(file: string): string {
  return createHash("sha1")
    .update(Buffer.from(file, "utf-8"))
    .digest("hex")
    .toUpperCase();
}

async function trackEntryFromFile(
  lib: string,
  file: string
): Promise<TrackEntry> {
  const [fstat, taggedFile] = await Promise.all([
    stat(file),
    MusicFile.load(file),
  ]);
  const extName = path.extname(file);

  let title = taggedFile.title || path.basename(file, extName);
  let album = taggedFile.album || "";
  const genre = taggedFile.genre || "";
  let artist = taggedFile.artist || "";
  let duration = taggedFile.duration || 0;
  let bitrate = taggedFile.bitRate || 0;
  const tracknumber = taggedFile.trackNumber || 10000;

  let tid = "";
  let aid = "";
  let artistid = "";
  let track = "";

  const metadata = commentToID3Metadata(taggedFile.comment);
  if (metadata) {
    tid = metadata.musicId;
    aid = `album${metadata.albumId}`;
    title = metadata.musicName;
    album = metadata.album;
    duration = metadata.duration;
    bitrate = metadata.bitrate / 1000;
    artist = "";

    const artists = [];

    for (const item of metadata.artist) {
      artist += `${item[0]},`;
      artistid += `${item[1]},`;
      artists.push({
        name: item[0],
        id: item[1],
      });
    }

    track = JSON.stringify({
      id: metadata.musicId,
      name: metadata.musicName,
      alias: metadata.alias,
      transNames: metadata.transNames,
      artists,
      album: {
        id: metadata.albumId,
        name: metadata.album,
        picId: metadata.albumPicDocId,
        picUrl: metadata.albumPic,
      },
      duration: metadata.duration,
      mvId: metadata.mvId,
      realSuffix: extName.substring(1),
      commentThreadId: "",
      bitrate: metadata.bitrate,
      volumeDelta: metadata.volumeDelta,
      privilege: metadata.privilege,
      fee: metadata.fee,
    });
  }

  return {
    file,
    tid,
    aid,
    dir: lib,
    title,
    album,
    genre,
    artist,
    duration,
    timestamp: Date.now(),
    bitrate,
    filesize: fstat.size,
    ignored: 0,
    id: generateTrackId(file),
    artistid,
    parentdir: path.dirname(file),
    track,
    librarypath: getLibraryPath(lib) || "",
    tracknumber,
    source: "",
    starttime: 0,
    type: 0,
  };
}

const libWatchers: Map<MusicLibraries, FSWatcher> = new Map();

export interface MusiclibraryDeps {
  database: Pick<DatabaseService, "musicLibraryDb">;
}

export function register(deps: MusiclibraryDeps): void {
  registerCallHandler<[string, string[]], [boolean]>(
    "musiclibrary.execSql",
    async (event, taskId, sql) => {
      try {
        const result = await deps.database.musicLibraryDb.executeSqls(sql);
        event.sender.send("channel.call", "musiclibrary.onexecsql", {
          error: 0,
          id: taskId,
          reason: "",
          result: true,
          ...result,
        });
      } catch (error) {
        LOGGER.error({ sql }, "Error executing music library SQL: %s", error);
        event.sender.send("channel.call", "musiclibrary.onexecsql", {
          error: 1,
          id: taskId,
          reason: "",
          result: false,
        });
      }
      return [true];
    }
  );

  registerCallHandler<[MusicLibraries], void>(
    "musiclibrary.observeLibrary",
    (event, lib) => {
      if (libWatchers.has(lib)) return;
      const libPath = getLibraryPath(lib);
      if (!libPath) return;

      try {
        const watcher = watch(
          libPath,
          {
            recursive: true,
            ignore: (path) => !(mime.getType(path) ?? "").startsWith("audio/"),
          },
          async (eventType, filename) => {
            if (!filename) return;
            if (!isMusicFile(filename)) return;
            const filePath = path.resolve(libPath, filename);
            const db = deps.database.musicLibraryDb;
            await db.exec("DELETE FROM track WHERE file = ?", [filePath]);
            try {
              const entry = await trackEntryFromFile(lib, filePath);
              await db.execNamed(
                `INSERT INTO track (file, tid, aid, dir, title, album, genre, artist, duration, timestamp, bitrate, filesize, ignored, id, artistid, parentdir, track, librarypath, tracknumber, source, starttime, type)
            VALUES (:file, :tid, :aid, :dir, :title, :album, :genre, :artist, :duration, :timestamp, :bitrate, :filesize, :ignored, :id, :artistid, :parentdir, :track, :librarypath, :tracknumber, :source, :starttime, :type)`,
                entry
              );
            } catch (err) {
              if (!isFileNotFound(err))
                LOGGER.error(
                  { filename, library: lib, err: toError(err) },
                  "Failed to refresh music metadata in library"
                );
            }
            event.sender.send("channel.call", "musiclibrary.onobserveLibrary", {
              library: lib,
            });
          }
        );
        watcher.on("error", (err) => {
          LOGGER.error({ err }, "Library observer encountered error");
        });
        libWatchers.set(lib, watcher);
      } catch (err) {
        if (!isFileNotFound(err))
          LOGGER.error(
            { library: lib, err: toError(err) },
            "Cannot monitor music library"
          );
      }
    }
  );

  registerCallHandler<[MusicLibraries], void>(
    "musiclibrary.removeObserveLibrary",
    (event, lib) => {
      const watcher = libWatchers.get(lib);
      if (!watcher) return;
      watcher.close();
      libWatchers.delete(lib);
    }
  );

  registerCallHandler<[MusicLibraries, number], [boolean]>(
    "musiclibrary.addLibrary",
    (event, library) => {
      (async () => {
        try {
          const libPath = getLibraryPath(library);
          if (!libPath || !(await fileExists(libPath))) {
            event.sender.send("channel.call", "musiclibrary.onaddend", {
              dirs: undefined,
              library,
              reason: "",
              result: 0,
            });
            return;
          }
          const db = deps.database.musicLibraryDb;

          const existingResult = await db.exec(
            "SELECT file, filesize, timestamp FROM track WHERE dir = ?",
            [library]
          );
          const existingRows: Array<Record<string, unknown>> =
            existingResult[1] ?? [];
          const existingMap = new Map<
            string,
            { filesize: number; timestamp: number }
          >();
          for (const row of existingRows) {
            existingMap.set(row["file"] as string, {
              filesize: Number(row["filesize"]),
              timestamp: Number(row["timestamp"]),
            });
          }

          const entries = await readdir(libPath, { recursive: true });
          let processed = 0;

          for (const relative of entries) {
            if (!isMusicFile(relative)) continue;
            try {
              const filePath = path.resolve(libPath, relative);

              const existing = existingMap.get(filePath);
              let needsUpdate = !existing; // new file, always index

              if (existing) {
                // File exists on disk — remove from map so we can detect stale entries later
                existingMap.delete(filePath);

                // Check metadata only: file size + last modify time vs stored timestamp
                const fstat = await stat(filePath);
                if (
                  fstat.size !== existing.filesize ||
                  fstat.mtimeMs > existing.timestamp
                ) {
                  needsUpdate = true;
                }
              }

              if (needsUpdate) {
                const entry = await trackEntryFromFile(library, filePath);
                await db.exec("DELETE FROM track WHERE file = ?", [filePath]);
                await db.execNamed(
                  `INSERT INTO track (file, tid, aid, dir, title, album, genre, artist, duration, timestamp, bitrate, filesize, ignored, id, artistid, parentdir, track, librarypath, tracknumber, source, starttime, type)
              VALUES (:file, :tid, :aid, :dir, :title, :album, :genre, :artist, :duration, :timestamp, :bitrate, :filesize, :ignored, :id, :artistid, :parentdir, :track, :librarypath, :tracknumber, :source, :starttime, :type)`,
                  entry
                );
              }

              processed++;

              // Progress update every 10 entries
              if (processed % 10 === 0) {
                event.sender.send(
                  "channel.call",
                  "musiclibrary.onaddprogress",
                  library,
                  processed
                );
              }
            } catch (err) {
              LOGGER.error(
                { filename: relative, library, err: toError(err) },
                "Failed to read music in library"
              );
            }
          }

          // If there are still files in the map, they are stale (in the db but not filesystem),
          // remove them here
          for (const staleFile of existingMap.keys()) {
            await db.exec("DELETE FROM track WHERE file = ?", [staleFile]);
          }

          event.sender.send("channel.call", "musiclibrary.onaddend", {
            dirs: [libPath],
            library,
            reason: "",
            result: 0,
          });
        } catch (err) {
          LOGGER.error({ err: toError(err) }, "Failed to add music library");
          event.sender.send("channel.call", "musiclibrary.onaddend", {
            dirs: undefined,
            library,
            reason: toError(err).message,
            result: 1,
          });
        }
      })();

      return [true];
    }
  );

  registerCallHandler<[string], [boolean]>(
    "musiclibrary.removeLibrary",
    (event, library) => {
      (async () => {
        try {
          const db = deps.database.musicLibraryDb;
          await db.exec("DELETE FROM track WHERE dir = ?", [library]);
        } catch (err) {
          LOGGER.error(
            { library, err: toError(err) },
            "Failed to delete tracks from library"
          );
        }
        event.sender.send(
          "channel.call",
          "musiclibrary.onremovelibrary",
          library
        );
      })();
      return [true];
    }
  );

  registerCallHandler<[string, string, boolean], void>(
    "musiclibrary.readMusicInfo",
    (event, taskId, path) => {
      (async () => {
        const fullPath = normalizePath(path);
        try {
          const [stats, taggedFile] = await Promise.all([
            stat(fullPath),
            MusicFile.load(fullPath),
          ]);

          event.sender.send(
            "channel.call",
            "musiclibrary.onreadmusicinfo",
            taskId,
            path,
            0,
            {
              album: taggedFile.album,
              artist: taggedFile.artist,
              audiomd5: "",
              bitrate: taggedFile.bitRate,
              comment: taggedFile.comment,
              duration: taggedFile.duration,
              filesize: stats.size,
              genre: taggedFile.genre,
              title: taggedFile.title || basename(fullPath),
            }
          );
        } catch (err) {
          event.sender.send(
            "channel.call",
            "musiclibrary.onreadmusicinfo",
            taskId,
            path,
            isFileNotFound(err) ? 5 : 6,
            {}
          );
        }
      })();
    }
  );
}

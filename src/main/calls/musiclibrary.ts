import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path, { basename } from "node:path";
import { createHash } from "node:crypto";

import { app } from "electron";
import { MusicTagger } from "music-tag-native";

import { getMusicLibraryDb } from "../database";
import { registerCallHandler } from "../calls";
import { isMusicFile, normalizePath } from "../util";

type MusicLibraries =
  | "<mymusic>"
  | "<download>"
  | "<windowsmedia>"
  | "<itunes>"
  | string;

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
  const fstat = await stat(file);

  const tagger = new MusicTagger();
  tagger.loadPath(file);

  const title = tagger.title || path.basename(file, path.extname(file));
  const album = tagger.album || "";
  const genre = tagger.genre || "";
  const artist = tagger.artist || "";
  const duration = tagger.duration || 0;
  const bitrate = tagger.bitRate || 0;
  const tracknumber = tagger.trackNumber || 0;

  tagger.dispose();

  return {
    file,
    tid: "",
    aid: "",
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
    artistid: "",
    parentdir: path.dirname(file),
    track: "",
    librarypath: getLibraryPath(lib) || "",
    tracknumber,
    source: "",
    starttime: 0,
    type: 0,
  };
}

registerCallHandler<[string, string[]], [boolean]>(
  "musiclibrary.execSql",
  async (event, taskId, sql) => {
    try {
      const result = getMusicLibraryDb().executeSqls(sql);
      event.sender.send("channel.call", "musiclibrary.onexecsql", {
        error: 0,
        id: taskId,
        reason: "",
        result: true,
        ...result,
      });
    } catch (error) {
      console.error(`Error executing music library SQL: ${error}`);
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

const libWatchers: Map<MusicLibraries, FSWatcher> = new Map();
registerCallHandler<[MusicLibraries], void>(
  "musiclibrary.observeLibrary",
  (event, lib) => {
    if (libWatchers.has(lib)) return;
    const libPath = getLibraryPath(lib);
    if (!libPath || !existsSync(libPath)) return;
    const watcher = watch(
      libPath,
      { recursive: true },
      async (eventType, filename) => {
        if (!filename) return;
        if (!isMusicFile(filename)) return;
        const filePath = path.join(libPath, filename);
        const db = getMusicLibraryDb();
        if (existsSync(filePath)) {
          const entry = await trackEntryFromFile(lib, filePath);
          db.exec("DELETE FROM track WHERE file = ?", [filePath]);
          db.execNamed(
            `INSERT INTO track (file, tid, aid, dir, title, album, genre, artist, duration, timestamp, bitrate, filesize, ignored, id, artistid, parentdir, track, librarypath, tracknumber, source, starttime, type)
             VALUES (:file, :tid, :aid, :dir, :title, :album, :genre, :artist, :duration, :timestamp, :bitrate, :filesize, :ignored, :id, :artistid, :parentdir, :track, :librarypath, :tracknumber, :source, :starttime, :type)`,
            entry
          );
        } else {
          db.exec("DELETE FROM track WHERE file = ?", [filePath]);
        }
        event.sender.send("channel.call", "musiclibrary.onobserveLibrary", {
          library: lib,
        });
      }
    );
    libWatchers.set(lib, watcher);
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
  async (_event, library) => {
    const libPath = getLibraryPath(library);
    if (!libPath || !existsSync(libPath)) return [true];
    const db = getMusicLibraryDb();

    const entries = await readdir(libPath, { recursive: true });
    for (const relative of entries) {
      if (!isMusicFile(relative)) continue;
      const filePath = path.join(libPath, relative);
      const entry = await trackEntryFromFile(library, filePath);
      db.exec("DELETE FROM track WHERE file = ?", [filePath]);
      db.execNamed(
        `INSERT INTO track (file, tid, aid, dir, title, album, genre, artist, duration, timestamp, bitrate, filesize, ignored, id, artistid, parentdir, track, librarypath, tracknumber, source, starttime, type)
         VALUES (:file, :tid, :aid, :dir, :title, :album, :genre, :artist, :duration, :timestamp, :bitrate, :filesize, :ignored, :id, :artistid, :parentdir, :track, :librarypath, :tracknumber, :source, :starttime, :type)`,
        entry
      );
    }

    return [true];
  }
);

registerCallHandler<[string, string, boolean], void>(
  "musiclibrary.readMusicInfo",
  (event, taskId, path) => {
    (async () => {
      const fullPath = normalizePath(path);
      if (!existsSync(fullPath)) {
        event.sender.send(
          "channel.call",
          "musiclibrary.onreadmusicinfo",
          taskId,
          path,
          5,
          {}
        );
        return;
      }
      const tagger = new MusicTagger();

      try {
        const stats = await stat(fullPath);

        tagger.loadPath(fullPath);

        event.sender.send(
          "channel.call",
          "musiclibrary.onreadmusicinfo",
          taskId,
          path,
          0,
          {
            album: tagger.album,
            artist: tagger.artist,
            audiomd5: "",
            bitrate: tagger.bitRate,
            comment: tagger.comment,
            duration: tagger.duration,
            filesize: stats.size,
            genre: tagger.genre,
            title: tagger.title || basename(fullPath),
          }
        );
      } catch {
        event.sender.send(
          "channel.call",
          "musiclibrary.onreadmusicinfo",
          taskId,
          path,
          6,
          {}
        );
      }

      if (!tagger.isDisposed()) tagger.dispose();
    })();
  }
);

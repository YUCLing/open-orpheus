import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path, { basename } from "node:path";
import { createHash } from "node:crypto";

import { app } from "electron";
import { MusicTagger } from "music-tag-native";

import { getMusicLibraryDb } from "../database";
import { registerCallHandler } from "../calls";
import { isMusicFile, normalizePath } from "../util";
import { toError } from "../../util";
import { commentToID3Metadata } from "../id3";

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
  const [fstat, content] = await Promise.all([stat(file), readFile(file)]);
  const extName = path.extname(file);

  const tagger = new MusicTagger();
  tagger.loadBuffer(content);

  let title = tagger.title || path.basename(file, extName);
  let album = tagger.album || "";
  const genre = tagger.genre || "";
  let artist = tagger.artist || "";
  let duration = tagger.duration || 0;
  let bitrate = tagger.bitRate || 0;
  const tracknumber = tagger.trackNumber || 10000;

  let tid = "";
  let aid = "";
  let artistid = "";
  let track = "";

  const metadata = commentToID3Metadata(tagger.comment);
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

  tagger.dispose();

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
        const filePath = path.resolve(libPath, filename);
        const db = getMusicLibraryDb();
        db.exec("DELETE FROM track WHERE file = ?", [filePath]);
        if (existsSync(filePath)) {
          try {
            const entry = await trackEntryFromFile(lib, filePath);
            db.execNamed(
              `INSERT INTO track (file, tid, aid, dir, title, album, genre, artist, duration, timestamp, bitrate, filesize, ignored, id, artistid, parentdir, track, librarypath, tracknumber, source, starttime, type)
              VALUES (:file, :tid, :aid, :dir, :title, :album, :genre, :artist, :duration, :timestamp, :bitrate, :filesize, :ignored, :id, :artistid, :parentdir, :track, :librarypath, :tracknumber, :source, :starttime, :type)`,
              entry
            );
          } catch (err) {
            console.error(
              "Failed to refresh music",
              filename,
              "metadata in library",
              lib,
              err
            );
          }
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
  (event, library) => {
    (async () => {
      try {
        const libPath = getLibraryPath(library);
        if (!libPath || !existsSync(libPath)) {
          event.sender.send("channel.call", "musiclibrary.onaddend", {
            dirs: undefined,
            library,
            reason: "",
            result: 0,
          });
          return;
        }
        const db = getMusicLibraryDb();

        const entries = await readdir(libPath, { recursive: true });
        for (const relative of entries) {
          if (!isMusicFile(relative)) continue;
          try {
            const filePath = path.resolve(libPath, relative);
            const entry = await trackEntryFromFile(library, filePath);
            db.exec("DELETE FROM track WHERE file = ?", [filePath]);
            db.execNamed(
              `INSERT INTO track (file, tid, aid, dir, title, album, genre, artist, duration, timestamp, bitrate, filesize, ignored, id, artistid, parentdir, track, librarypath, tracknumber, source, starttime, type)
              VALUES (:file, :tid, :aid, :dir, :title, :album, :genre, :artist, :duration, :timestamp, :bitrate, :filesize, :ignored, :id, :artistid, :parentdir, :track, :librarypath, :tracknumber, :source, :starttime, :type)`,
              entry
            );
          } catch (err) {
            console.error(
              "Failed to read music",
              relative,
              "in library",
              library,
              err
            );
          }
        }

        event.sender.send("channel.call", "musiclibrary.onaddend", {
          dirs: [libPath],
          library,
          reason: "",
          result: 0,
        });
      } catch (err) {
        console.error("Failed to add music library:", err);
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
      const db = getMusicLibraryDb();
      db.exec("DELETE FROM track WHERE dir = ?", [library]);
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

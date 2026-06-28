import { dirname, extname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { createHash } from "node:crypto";

import { Protocol } from "electron";
import mime from "mime";
import unzipper from "unzipper";
import { MusicFile } from "music-tag-native";

import packManager from "./pack";
import WebPack from "./packs/WebPack";
import {
  isFileNotFound,
  normalizePath,
  sanitizeRelativePath,
  selectBestMusicPic,
} from "./util";
import { data as dataDir, storage as storageDir, wasm } from "./folders";
import { client } from "./request";

class NetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

class LoadError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "LoadError";
  }
}

type SimpleResponse = {
  status?: number;
  content: BodyInit;
  contentType?: string;
  cacheable?: boolean;
};

async function loadFromFilePath(path: string): Promise<SimpleResponse> {
  try {
    const fileContent = await packManager
      .getPack<WebPack>("web")
      .readFile(path);
    const contentType =
      mime.getType(extname(path)) || "application/octet-stream";
    return { content: Buffer.from(fileContent), contentType };
  } catch {
    throw new LoadError("Not Found", 404);
  }
}

function getMd5(content: Uint8Array): string {
  return createHash("md5").update(content).digest("hex");
}

export async function loadFromOrpheusUrl(url: string): Promise<SimpleResponse> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "orpheus:") {
    throw new NetworkError(`Invalid URL protocol: ${parsedUrl.protocol}`);
  }

  switch (parsedUrl.hostname) {
    case "orpheus":
      // #region orpheus://orpheus/storage/local
      if (parsedUrl.pathname === "/storage/local") {
        const path = parsedUrl.searchParams.get("file");
        if (!path) {
          throw new LoadError("Bad Request: Missing file parameter", 400);
        }
        const filePath = sanitizeRelativePath(storageDir, path);
        if (filePath === false) {
          throw new LoadError("Bad Request: Invalid file path", 400);
        }
        return {
          content: await readFile(filePath),
          contentType:
            mime.getType(extname(filePath)) || "application/octet-stream",
          cacheable: false,
        };
      }
      // #endregion

      // #region orpheus://orpheus/wasm/
      if (parsedUrl.pathname.startsWith("/wasm/")) {
        const type = parsedUrl.pathname.slice("/wasm/".length);
        const rawSearchIndex = url.indexOf("?");
        const rawSearch =
          rawSearchIndex >= 0 ? url.slice(rawSearchIndex + 1) : "";
        const wasmParams = rawSearch.includes("&&")
          ? new URLSearchParams(
              rawSearch
                .replace(/&&/g, "__ORPHEUS_PARAM_SEP__")
                .replace(/&/g, "%26")
                .replace(/__ORPHEUS_PARAM_SEP__/g, "&")
            )
          : parsedUrl.searchParams;
        const wasmUrl = wasmParams.get("url");
        const md5 = wasmParams.get("MD5");
        const fetchFromServer = wasmParams.get("fetchFromServer") === "true";

        if (!wasmUrl || !md5) {
          throw new LoadError(
            "Bad Request: Missing url or MD5 parameter for wasm",
            400
          );
        }
        let fileExt: string;
        try {
          fileExt = extname(new URL(wasmUrl).pathname);
        } catch {
          fileExt = extname(wasmUrl);
        }
        const cachedPath = resolve(wasm, md5 + fileExt);
        let shouldWriteCache = fetchFromServer;
        let buf!: Buffer<ArrayBuffer>;
        const doFetch = async () => {
          const res = await client(wasmUrl, { throwHttpErrors: false });
          if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new LoadError(
              `Failed to fetch wasm from url: ${res.statusMessage}`,
              res.statusCode
            );
          }
          buf = Buffer.from(res.rawBody) as Buffer<ArrayBuffer>;
        };
        if (!fetchFromServer) {
          try {
            buf = (await readFile(cachedPath)) as Buffer<ArrayBuffer>;
            const actualMd5 = getMd5(buf);
            if (md5 !== actualMd5) {
              await doFetch();
              shouldWriteCache = true;
            }
          } catch (err) {
            if (isFileNotFound(err)) {
              await doFetch();
              shouldWriteCache = true;
            } else {
              throw err;
            }
          }
        } else {
          await doFetch();
        }
        const actualMd5 = getMd5(buf);
        if (md5 !== actualMd5) {
          throw new LoadError(
            `Wasm MD5 mismatch: expected ${md5} but got ${actualMd5}`,
            400
          );
        }
        if (shouldWriteCache) {
          await mkdir(wasm, { recursive: true });
          await writeFile(cachedPath, buf);
        }
        if (type === "SDK") {
          const name = wasmParams.get("name");
          if (!name) {
            throw new LoadError(
              "Bad Request: Missing name parameter for wasm SDK",
              400
            );
          }
          const zipper = await unzipper.Open.buffer(buf);
          const file = zipper.files.find(
            (f) => f.path.toLowerCase() === name.toLowerCase()
          );
          if (!file) {
            throw new LoadError(
              `Wasm SDK zip did not contain the requested file: ${name}`,
              404
            );
          }
          return {
            content: Buffer.from(await file.buffer()),
            contentType:
              mime.getType(extname(name)) || "application/octet-stream",
          };
        } else if (type === "resource") {
          return {
            content: buf,
            contentType: mime.getType(fileExt) || "application/octet-stream",
          };
        }
        throw new LoadError(`Bad Request: Unsupported wasm type: ${type}`, 400);
      }
      // #endregion

      // #region orpheus://orpheus/customskin
      if (parsedUrl.pathname === "/customskin") {
        const path = "wasm/skin/customskin";
        const rawSearchIndex = url.indexOf("?");
        const rawSearch =
          rawSearchIndex >= 0 ? url.slice(rawSearchIndex + 1) : "";
        const skinParams = rawSearch.includes("&&")
          ? new URLSearchParams(
              rawSearch
                .replace(/&&/g, "__ORPHEUS_PARAM_SEP__")
                .replace(/&/g, "%26")
                .replace(/__ORPHEUS_PARAM_SEP__/g, "&")
            )
          : parsedUrl.searchParams;
        const picUrl = skinParams.get("url");
        const name = skinParams.get("name");
        const fetchFromServer = skinParams.get("fetchFromServer") !== "false";

        // 1. Validate required parameters
        if (!name) {
          throw new LoadError(
            "Bad Request: Missing name parameter for custom skin",
            400
          );
        }

        const cachedPath = resolve(dataDir, path, name);
        let buf!: Buffer<ArrayBuffer>;

        // 2. Handle fetching or reading locally
        if (fetchFromServer) {
          if (!picUrl) {
            throw new LoadError(
              "Bad Request: Missing url parameter to fetch custom skin",
              400
            );
          }

          // Fetch from server
          const res = await client(picUrl, { throwHttpErrors: false });
          if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new LoadError(
              `Failed to fetch custom skin from url: ${res.statusMessage}`,
              res.statusCode
            );
          }

          buf = Buffer.from(res.rawBody) as Buffer<ArrayBuffer>;

          // Save it to path + name
          await mkdir(dirname(cachedPath), { recursive: true });
          await writeFile(cachedPath, buf);
        } else {
          // Read from path + name
          try {
            buf = (await readFile(cachedPath)) as Buffer<ArrayBuffer>;
          } catch (err) {
            if (isFileNotFound(err)) {
              throw new LoadError(
                `Not Found: Custom skin does not exist locally: ${name}`,
                404
              );
            }
            throw err;
          }
        }

        // 3. Respond with the fetched/read data
        return {
          content: buf,
          contentType:
            mime.getType(extname(name)) || "application/octet-stream",
        };
      }
      // #endregion

      // #region orpheus://orpheus/* (default)
      return await loadFromFilePath(parsedUrl.pathname);
    // #endregion
    // #region orpheus://cache
    case "cache": {
      const url = parsedUrl.search.substring(1); // remove leading '?'
      if (!url) {
        throw new LoadError("Bad Request: Missing URL parameter", 400);
      }
      if (url.startsWith("orpheus:")) {
        return loadFromOrpheusUrl(url);
      }
      const cacheStorage = (await import("./cache")).httpCacheStorage;
      if (!cacheStorage) {
        throw new LoadError("URL cache storage is unavailable", 500);
      }
      const response = await client(url, {
        throwHttpErrors: false,
        cache: cacheStorage,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new LoadError(
          `Failed to fetch resource: ${response.statusMessage}`,
          response.statusCode
        );
      }
      const contentType =
        response.headers["content-type"] || "application/octet-stream";
      return {
        content: response.rawBody,
        contentType,
      };
    }
    // #endregion
    case "localmusic": {
      // #region orpheus://localmusic/pic
      if (parsedUrl.pathname === "/pic") {
        const path = normalizePath(
          decodeURIComponent(parsedUrl.search.substring(1))
        ); // remove leading '?'
        try {
          const taggedFile = await MusicFile.load(path);
          const pictures = taggedFile.pictures;
          if (!pictures) {
            throw new LoadError("No pictures for this media", 404);
          }
          const pic = selectBestMusicPic(pictures);
          if (!pic) {
            throw new LoadError("No pictures for this media", 404);
          }
          return {
            // SAFETY: Uint8Array created by NAPI-RS
            content: pic.data.buffer as unknown as ArrayBuffer,
            contentType: pic.mimeType ?? "image/png",
          };
        } catch (err) {
          if (err instanceof LoadError) throw err;
          throw new LoadError("Failed to load the file", 404);
        }
      }
      // #endregion

      // #region orpheus://localmusic/lyric
      if (parsedUrl.pathname === "/lyric") {
        const path = normalizePath(
          decodeURIComponent(parsedUrl.search.substring(1))
        ); // remove leading '?'
        try {
          const taggedFile = await MusicFile.load(path);
          const lyrics = taggedFile.lyrics;
          if (!lyrics) {
            // NCM accepts everything, must return with hard error
            throw lyrics; // try catch will convert it to NetworkError
          }
          return {
            content: lyrics,
            contentType: "text/plain",
          };
        } catch {
          throw new NetworkError("No lyrics");
        }
      }
      // #endregion

      throw new LoadError("Not Found", 404);
    }
    default:
      throw new NetworkError(`Unknown URL hostname: ${parsedUrl.hostname}`);
  }
}

export default function registerOrpheusScheme(protocol: Protocol) {
  protocol.handle("orpheus", async (request) => {
    try {
      const {
        status = 200,
        content,
        contentType,
        cacheable,
      } = await loadFromOrpheusUrl(request.url);
      const headers: Record<string, string> = {};
      if (contentType) {
        headers["Content-Type"] = contentType;
      }
      if (!cacheable) {
        headers["Cache-Control"] = "no-store";
      }
      return new Response(content, {
        status,
        headers,
      });
    } catch (error) {
      if (error instanceof LoadError) {
        return new Response(error.message, { status: error.status });
      } else if (error instanceof NetworkError) {
        return Response.error();
      }
      return new Response("Internal Server Error", { status: 500 });
    }
  });
}

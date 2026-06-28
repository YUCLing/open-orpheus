import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { MusicFile } from "music-tag-native";
import type { Progress } from "got";

import { registerCallHandler } from "../calls";
import { serialData } from "../crypto";
import { client, type ProxyTypes } from "../request";
import { isFileNotFound, normalizePath } from "../util";
import { basename, extname } from "node:path";

type UploadPayload = {
  encrypt: 0 | 1;
  audioMd5CheckUrl: string;
  audioMd5CheckUri: string;
  uploadCheckUrl: string;
  uploadUrl: string;
  uploadMetaUrl: string;
  uploadMetaUri: string;
  domain: string;
  title: string;
  album: string | "";
  artist: string | "";
  cookie: string;
  path: string;
  bitrate: number;
  songId: string;
  tracktype: 0;
  starttime: number | 0;
  duration: number;
  proxytype: ProxyTypes;
  host: string;
  port: string;
  username: string;
  password: string;
  encryptParam: string;
  bucket: string;
  token: string;
  objectKey: string;
  docId: string;
  context: string;
  apiCheckTokenList: Record<string, { checkToken: string }>;
};

async function handleUpload(
  event: Electron.IpcMainInvokeEvent,
  payload: UploadPayload
) {
  const uploadClient = client.extend({
    cookieJar: undefined, // Manages cookie manually here.
  });

  const fullPath = normalizePath(payload.path);

  try {
    const [stats, content] = await Promise.all([
      stat(fullPath),
      readFile(fullPath),
    ]);

    event.sender.send(
      "channel.call",
      "subprocess.oncall",
      0,
      "upload.onUpload",
      JSON.stringify({
        activeCode: 0,
        code: 0,
        end: false,
        path: payload.path,
        response: "",
        schedule: 0.0,
        songId: "",
        upload: {},
        url: "",
      })
    );

    const taggedFile = await MusicFile.load(content);

    const md5 = createHash("md5").update(content).digest("hex");

    const encryptParam = JSON.parse(payload.encryptParam);
    const checkToken = payload.apiCheckTokenList[payload.audioMd5CheckUri]
      ? payload.apiCheckTokenList[payload.audioMd5CheckUri].checkToken
      : undefined;

    // We can ignore the proxy config in payload, since we are simply using the same client here.
    const checkRes = await uploadClient
      .post(payload.audioMd5CheckUrl, {
        headers: {
          "X-antiCheatToken": checkToken,
          Cookie: payload.cookie,
        },
        form: {
          params: serialData(payload.audioMd5CheckUri, {
            ...encryptParam,
            bitrate: taggedFile.bitRate,
            checkToken,
            ext: extname(fullPath),
            length: stats.size,
            md5,
            songId: "0",
            version: 1,
          }),
        },
      })
      .json<{
        songId: string;
        needUpload: boolean;
        code: number;
      }>();

    if (checkRes.code !== 200) {
      throw new Error("Upload check failed");
    }

    const filename = basename(fullPath);

    if (checkRes.needUpload) {
      let upload: Record<string, unknown> = {};

      const allocRes = await uploadClient
        .post(`${payload.domain}/api/whale/token/alloc`, {
          headers: {
            Cookie: payload.cookie,
          },
          form: {
            bizKey: "9af6516d",
            bucket: "jd-musicrep-privatecloud-audio-public",
            channel: "3",
            filename,
            md5,
            type: "audio",
          },
        })
        .json<{
          code: number;
          data: {
            bucket: string;
            key: string;
            objectKey: string;
            token: string;
            accessKeyId: null;
            secretAccessKey: null;
            resourceId: number;
            channel: number;
            region: string;
            endpoint: null;
            outerUrl: string;
          };
          message: string;
        }>();

      if (allocRes.code !== 200) {
        throw new Error("NOS alloc failed");
      }

      upload = {
        bucket: allocRes.data.bucket,
        context: "",
        docId: allocRes.data.resourceId,
        objectKey: allocRes.data.token,
        uploadChannel: "Nos",
      };

      event.sender.send(
        "channel.call",
        "subprocess.oncall",
        0,
        "upload.onUpload",
        JSON.stringify({
          activeCode: 0,
          code: 0,
          end: false,
          path: payload.path,
          response: "",
          schedule: 0.0,
          songId: "",
          upload,
          url: "",
        })
      );

      const lbsRes = await uploadClient(
        `http://wanproxy.127.net/lbs?version=1.0&bucketname=${allocRes.data.bucket}`
      ).json<{
        lbs: string;
        upload: string[];
      }>();

      const uploadUrl = lbsRes.upload[0];
      const uploadReq = uploadClient.stream.post(
        `${uploadUrl}/${allocRes.data.bucket}/${encodeURIComponent(allocRes.data.objectKey)}?offset=0&complete=true&version=1.0`,
        {
          headers: {
            "x-nos-token": allocRes.data.token,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: content,
        }
      );

      uploadReq.on("uploadProgress", (progress: Progress) => {
        event.sender.send(
          "channel.call",
          "subprocess.oncall",
          0,
          "upload.onUpload",
          JSON.stringify({
            activeCode: 0,
            code: 0,
            end: false,
            path: payload.path,
            response: "",
            schedule: progress.percent,
            songId: "",
            upload,
            url: "",
          })
        );
      });

      const uploadRes = await new Promise<{
        requestId: string;
        offset: number;
        context: string;
        callbackRetMsg: string;
      }>((resolve, reject) => {
        const chunks: Buffer[] = [];
        uploadReq.on("data", (e) => {
          chunks.push(e);
        });
        uploadReq.on("end", () => {
          const json = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve(JSON.parse(json));
          } catch (e) {
            reject(e);
          }
        });
        uploadReq.on("error", (err) => {
          reject(err);
        });
      });

      upload.context = uploadRes.context;
      upload.token = allocRes.data.token;

      event.sender.send(
        "channel.call",
        "subprocess.oncall",
        0,
        "upload.onUpload",
        JSON.stringify({
          activeCode: 0,
          code: 0,
          end: false,
          path: payload.path,
          response: "",
          schedule: 1.0,
          songId: "",
          upload,
          url: "",
        })
      );

      const uploadMetaRes = await uploadClient.post(payload.uploadMetaUrl, {
        headers: {
          Cookie: payload.cookie,
        },
        form: {
          params: serialData(payload.uploadMetaUri, {
            ...encryptParam,
            album: payload.album,
            artist: payload.artist,
            bitrate: payload.bitrate,
            filename,
            md5,
            objectKey: `${allocRes.data.bucket}/${allocRes.data.objectKey}`,
            resourceId: allocRes.data.resourceId,
            song: payload.title,
            songid: checkRes.songId,
          }),
        },
      });

      const cloudInfo = JSON.parse(uploadMetaRes.body);

      if (cloudInfo.code !== 200) {
        throw new Error("Meta upload failed");
      }

      event.sender.send(
        "channel.call",
        "subprocess.oncall",
        0,
        "upload.onUpload",
        JSON.stringify({
          activeCode: 0,
          code: 0,
          end: true,
          path: payload.path,
          response: uploadMetaRes.body,
          schedule: 1.0,
          songId: cloudInfo.songId,
          upload,
          url: payload.uploadMetaUrl,
        })
      );
    } else {
      const uploadMetaRes = await uploadClient.post(payload.uploadMetaUrl, {
        headers: {
          Cookie: payload.cookie,
        },
        form: {
          params: serialData(payload.uploadMetaUri, {
            ...encryptParam,
            album: payload.album,
            artist: payload.artist,
            bitrate: payload.bitrate,
            filename,
            md5,
            song: payload.title,
            songid: checkRes.songId,
          }),
        },
      });

      const cloudInfo = JSON.parse(uploadMetaRes.body);

      if (cloudInfo.code !== 200) {
        throw new Error("Meta upload failed");
      }

      console.log(uploadMetaRes.body);

      event.sender.send(
        "channel.call",
        "subprocess.oncall",
        0,
        "upload.onUpload",
        JSON.stringify({
          activeCode: 0,
          code: 0,
          end: true,
          path: payload.path,
          response: uploadMetaRes.body,
          schedule: 1.0,
          songId: cloudInfo.songId,
          upload: {},
          url: payload.uploadMetaUrl,
        })
      );
    }
  } catch (e) {
    if (!isFileNotFound(e)) console.error("Upload failed", e);
    event.sender.send(
      "channel.call",
      "subprocess.oncall",
      0,
      "upload.onUpload",
      JSON.stringify({
        activeCode: 0,
        code: -5,
        end: true,
        path: payload.path,
        response: "",
        schedule: 1.0,
        songId: "",
        upload: {},
        url: payload.audioMd5CheckUrl,
      })
    );
  }
}

registerCallHandler<[number, string, string, string], void>(
  "process.call",
  (event, num, exe, action, payload) => {
    if (exe === "cloudmusic_util") {
      if (action === "upload.upload") {
        handleUpload(event, JSON.parse(payload));
      }
    }
  }
);

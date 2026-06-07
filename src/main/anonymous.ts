/*
Our requests to /register/anonimous API are still problematic (server returns 400),
this module is used to workaround it. Tho it's quite hacky, but it works, confirmed
by our tests.
We are still looking to solve the 400 issue properly.
See https://github.com/YUCLing/open-orpheus/pull/75
*/

import { randomBytes } from "node:crypto";

import type { NetworkFetchRequest } from "./calls/network";
import { deserialData, encodeAnonymousId } from "./crypto";
import { client } from "./request";

const ANONYMOUS_REGISTER_PATH = "/api/register/anonimous";
const ANONYMOUS_EAPI_REGISTER_PATH = "/eapi/register/anonimous";
const MUSIC_ORIGIN = "https://music.163.com";
const ANONYMOUS_REGISTER_API_URL = `${MUSIC_ORIGIN}${ANONYMOUS_REGISTER_PATH}`;
const MAX_ANONYMOUS_REGISTER_ATTEMPTS = 15;

function createAnonymousUsername() {
  const id = randomBytes(26).toString("hex").toUpperCase();
  return Buffer.from(`${id} ${encodeAnonymousId(id)}`, "utf8").toString(
    "base64"
  );
}

function isAnonymousRegisterRequest(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.endsWith("music.163.com") &&
      (parsed.pathname === ANONYMOUS_REGISTER_PATH ||
        parsed.pathname === ANONYMOUS_EAPI_REGISTER_PATH)
    );
  } catch {
    return false;
  }
}

type Response = {
  blob: string;
  retryTimes: number;
  headers: Record<string, string>;
  status: number;
};

function parseResponseCode(blob: string) {
  try {
    return JSON.parse(blob)?.code;
  } catch {
    return undefined;
  }
}

export default async function interceptAnonymousRequest(
  request: NetworkFetchRequest
): Promise<[Response | Error, number, number] | null> {
  if (!isAnonymousRegisterRequest(request.url)) return null;

  let sucCount = 0,
    failCount = 0;

  async function doRequest(
    request: NetworkFetchRequest,
    decrypt = Boolean(request.isDecrypt)
  ): Promise<Response> {
    const response = await client(request.url, {
      method: request.method,
      headers: {
        ...request.headers,
      },
      body: request.body || undefined,
      throwHttpErrors: false,
      retry: {
        limit: request.retryCount,
        backoffLimit: 10000,
      },
      hooks: {
        beforeRetry: [
          () => {
            failCount++;
          },
        ],
      },
    });

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) {
        headers[key] = value.join(", ");
      } else if (value !== undefined) {
        headers[key] = value;
      }
    }

    const responseBody = Buffer.from(response.rawBody);
    const blob = decrypt
      ? deserialData(
          responseBody.buffer.slice(
            responseBody.byteOffset,
            responseBody.byteOffset + responseBody.byteLength
          )
        )
      : responseBody.toString();

    sucCount++;

    return {
      blob,
      retryTimes: 0,
      headers,
      status: response.statusCode,
    };
  }

  try {
    // Let's do the first request directly
    const res = await doRequest(request);

    if (parseResponseCode(res.blob) === 400) {
      // Oops, failed, run the attempts
      let lastRes = res;
      for (
        let attempt = 2;
        attempt <= MAX_ANONYMOUS_REGISTER_ATTEMPTS;
        attempt++
      ) {
        const res = await doRequest(
          {
            ...request,
            url: ANONYMOUS_REGISTER_API_URL,
            method: "POST",
            headers: {
              Accept: "*/*",
              "Content-Type": "application/x-www-form-urlencoded",
              Referer: `${MUSIC_ORIGIN}/`,
            },
            body: new URLSearchParams({
              username: createAnonymousUsername(),
            }).toString(),
            retryCount: 0,
            isDecrypt: false,
          },
          false
        );
        lastRes = res;
        if (parseResponseCode(res.blob) === 400) continue;
        return [res, sucCount, failCount];
      }
      return [lastRes, sucCount, failCount];
    }

    return [res, sucCount, failCount];
  } catch (err) {
    let e: Error;
    if (err instanceof Error) {
      e = err;
    } else {
      e = new Error(String(err));
    }
    return [e, sucCount, failCount];
  }
}

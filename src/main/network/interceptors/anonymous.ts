/*
Our requests to /register/anonimous are still problematic (server returns 400),
this interceptor works around it. Tho it's quite hacky, it works, confirmed
by tests. We are still looking to solve the 400 issue properly.
See https://github.com/YUCLing/open-orpheus/pull/75
*/

import { randomBytes } from "node:crypto";

import { toError } from "@shared/util";

import type { NetworkFetchRequest, NetworkInterceptor } from "../types";
import { encodeAnonymousId } from "@main/crypto";
import { isNCMUrl } from "@main/util/url";

const PATH_REGEX = /^\/[a-z]*api\/register\/anonimous\/?$/;
const MUSIC_ORIGIN = "https://music.163.com";
const ANONYMOUS_REGISTER_API_URL = `${MUSIC_ORIGIN}/api/register/anonimous`;
const MAX_ANONYMOUS_REGISTER_ATTEMPTS = 15;

function createAnonymousUsername(): string {
  const id = randomBytes(26).toString("hex").toUpperCase();
  return Buffer.from(`${id} ${encodeAnonymousId(id)}`, "utf8").toString("base64");
}

function isAnonymousRegisterRequest(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isNCMUrl(parsed) && PATH_REGEX.test(parsed.pathname);
  } catch {
    return false;
  }
}

function parseResponseCode(blob: string | undefined): number | undefined {
  if (blob === undefined) return undefined;
  try {
    return JSON.parse(blob)?.code;
  } catch {
    return undefined;
  }
}

export const anonymousRegisterInterceptor: NetworkInterceptor = {
  name: "anonymous-register",

  async onRequest(ctx) {
    const request = ctx.request as NetworkFetchRequest;
    if (!isAnonymousRegisterRequest(request.url)) return;

    LOGGER.debug(
      { path: new URL(request.url).pathname, retryCount: request.retryCount },
      "Intercepted anonymous register request"
    );

    const makeRetryRequest = (): NetworkFetchRequest => ({
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
      // Single-shot: the ladder owns the retrying, each attempt is one request.
      retryCount: 0,
      isDecrypt: false,
    });

    try {
      let result = await ctx.execute(request);
      let code = parseResponseCode(result.blob);

      if (code === 400) {
        LOGGER.debug(
          { attempts: MAX_ANONYMOUS_REGISTER_ATTEMPTS },
          "Anonymous register rejected, retrying with fresh usernames"
        );
        for (let attempt = 2; attempt <= MAX_ANONYMOUS_REGISTER_ATTEMPTS; attempt++) {
          result = await ctx.execute(makeRetryRequest());
          code = parseResponseCode(result.blob);
          if (code !== 400) break;
        }
        if (code === 400) {
          LOGGER.warn(
            { attempts: MAX_ANONYMOUS_REGISTER_ATTEMPTS },
            "Anonymous register retries exhausted"
          );
        }
      }

      ctx.respondWith({ code: 0, error: "", ...result, retryTimes: 0 });
    } catch (err) {
      LOGGER.error({ err: toError(err) }, "Anonymous register request failed");
      throw err;
    }
  },
};

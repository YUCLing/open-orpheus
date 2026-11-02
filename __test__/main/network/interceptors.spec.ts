import { describe, expect, it, vi } from "vitest";

import { anonymousRegisterInterceptor } from "@main/network/interceptors/anonymous";
import { updateBlocker } from "@main/network/interceptors/update";
import type { NetworkFetchRequest, RequestContext } from "@main/network/types";

function createContext(url: string) {
  const request: NetworkFetchRequest = { url, method: "GET", headers: {} };
  const execute = vi.fn(async (_request?: NetworkFetchRequest) => ({
    blob: "",
    headers: {},
    status: 200,
    retryTimes: 0,
  }));
  const respondWith = vi.fn();
  const ctx: RequestContext = {
    request,
    state: {
      stats: { globalSucCount: 0, globalFailCount: 0 },
      tags: {},
    },
    execute,
    respondWith,
  };
  return { ctx, execute, respondWith };
}

describe("updateBlocker", () => {
  it.each([
    "https://music.163.com/api/pc/upgrade/get",
    "https://music.163.com/eapi/pc/upgrade/get/",
    "https://music.163.com/api/pc/upgrade/get?channel=pc",
  ])("answers %s with a synthetic no-update response", async (url) => {
    const { ctx, respondWith } = createContext(url);

    await updateBlocker.onRequest?.(ctx);

    expect(respondWith).toHaveBeenCalledTimes(1);
    const [response] = respondWith.mock.calls[0];
    // A synthetic response must look like a normal 200 JSON reply.
    expect(response).toMatchObject({
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(response.blob)).toEqual({ code: 200, data: {}, message: "" });
  });

  it.each([
    "https://music.163.com/api/pc/upgrade/check",
    "https://music.163.com/api/pc/upgrade/get/extra",
    "https://example.com/api/pc/upgrade/get",
    "https://notmusic.163.com/api/pc/upgrade/get",
    "https://music.163.com.evil.example/api/pc/upgrade/get",
    "not a url",
  ])("leaves %s alone", async (url) => {
    const { ctx, respondWith } = createContext(url);

    await updateBlocker.onRequest?.(ctx);

    expect(respondWith).not.toHaveBeenCalled();
  });
});

describe("anonymousRegisterInterceptor", () => {
  it.each([
    "https://music.163.com/api/register/anonimousX",
    "https://music.163.com/api/register",
    "https://example.com/api/register/anonimous",
  ])("ignores %s", async (url) => {
    const { ctx, execute, respondWith } = createContext(url);

    await anonymousRegisterInterceptor.onRequest?.(ctx);

    expect(execute).not.toHaveBeenCalled();
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("retries with a fresh username when the server answers 400", async () => {
    const { ctx, execute, respondWith } = createContext(
      "https://music.163.com/api/register/anonimous"
    );
    execute
      .mockResolvedValueOnce({
        blob: JSON.stringify({ code: 400 }),
        headers: {},
        status: 200,
        retryTimes: 0,
      })
      .mockResolvedValueOnce({
        blob: JSON.stringify({ code: 200, data: { ok: true } }),
        headers: {},
        status: 200,
        retryTimes: 0,
      });

    await anonymousRegisterInterceptor.onRequest?.(ctx);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toMatchObject({
      url: "https://music.163.com/api/register/anonimous",
      method: "GET",
    });
    expect(execute.mock.calls[1][0]).toMatchObject({
      url: "https://music.163.com/api/register/anonimous",
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://music.163.com/",
      },
      retryCount: 0,
      isDecrypt: false,
    });

    const username = new URLSearchParams(execute.mock.calls[1][0]!.body as string).get("username");
    expect(username).toBeTruthy();
    // "<52 hex chars> <encoded anonymous id>", base64 encoded.
    const decoded = Buffer.from(username!, "base64").toString("utf8");
    expect(decoded).toMatch(/^[0-9A-F]{52} [A-Za-z0-9+/=]+$/);

    expect(respondWith).toHaveBeenCalledTimes(1);
    expect(respondWith.mock.calls[0][0]).toMatchObject({
      code: 0,
      error: "",
      retryTimes: 0,
      blob: JSON.stringify({ code: 200, data: { ok: true } }),
    });
  });

  it("stops after the maximum number of attempts and still answers", async () => {
    const { ctx, execute, respondWith } = createContext(
      "https://music.163.com/api/register/anonimous"
    );
    execute.mockResolvedValue({
      blob: JSON.stringify({ code: 400 }),
      headers: {},
      status: 200,
      retryTimes: 0,
    });

    await anonymousRegisterInterceptor.onRequest?.(ctx);

    expect(execute).toHaveBeenCalledTimes(15);
    expect(respondWith).toHaveBeenCalledTimes(1);
    expect(respondWith.mock.calls[0][0]).toMatchObject({
      code: 0,
      blob: JSON.stringify({ code: 400 }),
    });
  });

  it("propagates executor failures", async () => {
    const { ctx, execute, respondWith } = createContext(
      "https://music.163.com/api/register/anonimous"
    );
    execute.mockRejectedValue(new Error("socket hang up"));

    await expect(anonymousRegisterInterceptor.onRequest?.(ctx)).rejects.toThrow("socket hang up");

    expect(respondWith).not.toHaveBeenCalled();
  });
});

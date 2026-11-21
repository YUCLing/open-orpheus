import { describe, expect, it, vi } from "vitest";

import { activate, deactivate } from "./index";

interface TestResponse {
  blob?: string;
  headers?: Record<string, string>;
  status?: number;
}

interface TestContext {
  request: { url: string };
  respondWith: (response: TestResponse) => void;
}

function createContext(url: string) {
  const respondWith = vi.fn();
  const ctx: TestContext = { request: { url }, respondWith };
  return { ctx, respondWith };
}

async function activatePlugin() {
  const use = vi.fn();
  const unuse = vi.fn();
  const pipeline = { use, unuse };
  const load = vi.fn(async (key: string) => {
    if (key === "@main/util/url") {
      return {
        isNCMUrl: (url: string | URL) => new URL(url).hostname === "music.163.com",
      };
    }
    if (key === "@main/network/interceptor") {
      return { networkInterceptorPipeline: pipeline };
    }
    throw new Error(`unexpected registry key: ${key}`);
  });

  const runtime = { registry: { load } } as unknown as Parameters<typeof activate>[0];
  await activate(runtime);

  const interceptor = use.mock.calls[0]?.[0] as {
    onRequest?: (ctx: TestContext) => void | Promise<void>;
  };
  return { interceptor, unuse };
}

describe("built-in update-blocker plugin", () => {
  it.each([
    "https://music.163.com/api/pc/upgrade/get",
    "https://music.163.com/eapi/pc/upgrade/get/",
    "https://music.163.com/api/pc/upgrade/get?channel=pc",
  ])("answers %s with a synthetic no-update response", async (url) => {
    const { interceptor } = await activatePlugin();
    const { ctx, respondWith } = createContext(url);

    await interceptor.onRequest?.(ctx);

    expect(respondWith).toHaveBeenCalledTimes(1);
    const [response] = respondWith.mock.calls[0];
    // A synthetic response must look like a normal 200 JSON reply.
    expect(response).toMatchObject({
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(response.blob ?? "{}")).toEqual({ code: 200, data: {}, message: "" });
  });

  it.each([
    "https://music.163.com/api/pc/upgrade/check",
    "https://music.163.com/api/pc/upgrade/get/extra",
    "https://example.com/api/pc/upgrade/get",
    "https://notmusic.163.com/api/pc/upgrade/get",
    "https://music.163.com.evil.example/api/pc/upgrade/get",
    "not a url",
  ])("leaves %s alone", async (url) => {
    const { interceptor } = await activatePlugin();
    const { ctx, respondWith } = createContext(url);

    await interceptor.onRequest?.(ctx);

    expect(respondWith).not.toHaveBeenCalled();
  });

  it("removes the interceptor on deactivate", async () => {
    const { unuse } = await activatePlugin();

    await deactivate?.();

    expect(unuse).toHaveBeenCalledWith("update-blocker");
  });
});

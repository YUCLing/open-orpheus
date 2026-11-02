import { describe, expect, it, vi } from "vitest";

import type {
  InterceptorState,
  NetworkFetchRequest,
  NetworkFetchResponse,
} from "@main/network/types";

import { dispatcher } from "../../../src/main/calls";
// Importing the module installs the `network.fetch` handler on the dispatcher.
import "../../../src/main/calls/network";

const hoisted = vi.hoisted(() => ({
  executeNetworkRequest:
    vi.fn<
      (
        request: NetworkFetchRequest,
        state: InterceptorState
      ) => Promise<Partial<NetworkFetchResponse>>
    >(),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), isPackaged: false },
  session: { defaultSession: {} },
}));

vi.mock("@main/network/handler", () => ({
  DEFAULT_RETRY_COUNT: 1,
  executeNetworkRequest: hoisted.executeNetworkRequest,
}));

async function fetch(request: Record<string, unknown>) {
  const callback = vi.fn();
  await dispatcher.dispatch("network.fetch", callback, { sender: "test" }, request);
  const [response] = callback.mock.calls[0] ?? [];
  return response as NetworkFetchResponse;
}

describe("network.fetch", () => {
  it("counts a terminal failure on top of the retries already recorded", async () => {
    hoisted.executeNetworkRequest.mockImplementationOnce(async (_request, state) => {
      state.stats.globalSucCount++;
      return { blob: '{"code":200}', headers: {}, status: 200, retryTimes: 0 };
    });

    const ok = await fetch({ url: "https://music.163.com/api/ok", method: "GET" });
    expect(ok).toMatchObject({
      code: 0,
      error: "",
      blob: '{"code":200}',
      status: 200,
      retryTimes: 0,
      globalSucCount: 1,
      globalFailCount: 0,
    });

    hoisted.executeNetworkRequest.mockImplementationOnce(async (_request, state) => {
      // Simulate one `beforeRetry` hit, then a terminal network failure.
      state.stats.globalFailCount++;
      throw new Error("boom");
    });

    const failed = await fetch({ url: "https://music.163.com/api/fail", method: "GET" });
    expect(failed).toMatchObject({
      code: 28,
      error: "boom",
      status: 0,
      blob: "",
      headers: {},
      retryTimes: 0,
      globalSucCount: 1,
      // one retry + the terminal failure
      globalFailCount: 2,
    });
  });
});

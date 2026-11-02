import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InterceptorState, NetworkFetchRequest } from "@main/network/types";

const hoisted = vi.hoisted(() => ({
  client: vi.fn(),
}));

vi.mock("@main/request", () => ({
  client: hoisted.client,
}));

import { DEFAULT_RETRY_COUNT, executeNetworkRequest } from "@main/network/handler";

const URL = "https://music.163.com/api/test";

function createState(): InterceptorState {
  return { stats: { globalSucCount: 0, globalFailCount: 0 }, tags: {} };
}

function createRequest(retryCount?: number): NetworkFetchRequest {
  return { url: URL, method: "GET", retryCount };
}

function gotResponse(retryCount: number) {
  return { headers: {}, rawBody: Buffer.from("ok"), statusCode: 200, retryCount };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeNetworkRequest retry policy", () => {
  it("uses the default retry count when the request does not specify one", async () => {
    hoisted.client.mockResolvedValue(gotResponse(0));

    await executeNetworkRequest(createRequest(), createState());

    expect(hoisted.client).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ retry: { limit: DEFAULT_RETRY_COUNT, backoffLimit: 10_000 } })
    );
  });

  it("uses the retry count carried by the request", async () => {
    hoisted.client.mockResolvedValue(gotResponse(2));

    const result = await executeNetworkRequest(createRequest(3), createState());

    expect(hoisted.client).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ retry: { limit: 3, backoffLimit: 10_000 } })
    );
    // A budget of 3 attempts after 2 retries leaves no attempts.
    expect(result.retryTimes).toBe(0);
  });

  it("disables retries for a single-shot request", async () => {
    hoisted.client.mockResolvedValue(gotResponse(0));

    const result = await executeNetworkRequest(createRequest(0), createState());

    expect(hoisted.client).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ retry: { limit: 0, backoffLimit: 10_000 } })
    );
    // Never report a negative number of remaining attempts.
    expect(result.retryTimes).toBe(0);
  });
});

describe("executeNetworkRequest accounting", () => {
  it("counts a success and returns the body", async () => {
    hoisted.client.mockResolvedValue(gotResponse(0));
    const state = createState();

    const result = await executeNetworkRequest(createRequest(), state);

    expect(result).toMatchObject({ blob: "ok", status: 200, retryTimes: 0 });
    expect(state.stats.globalSucCount).toBe(1);
    expect(state.stats.globalFailCount).toBe(0);
  });
});

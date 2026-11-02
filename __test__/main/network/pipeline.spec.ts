import { describe, expect, it, vi } from "vitest";

import { NetworkInterceptorPipeline } from "@main/network/pipeline";
import type {
  InterceptorState,
  NetworkExecutor,
  NetworkFetchRequest,
  NetworkFetchResponse,
} from "@main/network/types";

const request: NetworkFetchRequest = {
  url: "https://music.163.com/api/test",
  method: "GET",
  headers: { accept: "application/json" },
};

function createState(): InterceptorState {
  return {
    stats: { globalSucCount: 0, globalFailCount: 0 },
    tags: {},
  };
}

function createExecutor() {
  return vi.fn(async (_request: NetworkFetchRequest, _state: InterceptorState) => ({
    blob: '{"code":200}',
    headers: { "content-type": "application/json" },
    status: 200,
    retryTimes: 0,
  }));
}

describe("NetworkInterceptorPipeline", () => {
  it("runs interceptors in order against a private copy of the request", async () => {
    const seen: string[] = [];
    const executor = createExecutor();
    const pipeline = new NetworkInterceptorPipeline()
      .use({
        name: "first",
        onRequest: (ctx) => {
          seen.push("first");
          ctx.request.headers!.accept = "text/plain";
        },
      })
      .use({
        name: "second",
        onRequest: () => {
          seen.push("second");
        },
      });

    const response = await pipeline.run(request, createState(), executor);

    expect(seen).toEqual(["first", "second"]);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0].headers).toEqual({ accept: "text/plain" });
    // The caller's request object is never mutated.
    expect(request.headers).toEqual({ accept: "application/json" });
    expect(response).toMatchObject({
      code: 0,
      error: "",
      blob: '{"code":200}',
      status: 200,
      retryTimes: 0,
    });
  });

  it("skips the executor and the remaining interceptors for synthetic responses", async () => {
    const executor = createExecutor();
    const laterHooks = vi.fn();
    const pipeline = new NetworkInterceptorPipeline()
      .use({
        name: "blocker",
        onRequest: ({ respondWith }) => {
          respondWith({
            blob: "{}",
            headers: { "content-type": "application/json" },
            status: 200,
          });
        },
      })
      .use({
        name: "later",
        onRequest: laterHooks,
        onResponse: laterHooks,
        onError: laterHooks,
      });

    const response = await pipeline.run(request, createState(), executor);

    expect(executor).not.toHaveBeenCalled();
    expect(laterHooks).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      code: 0,
      error: "",
      blob: "{}",
      status: 200,
      retryTimes: 0,
    });
  });

  it("treats the shared state as the source of truth for counters", async () => {
    const executor = vi.fn(async (_request: NetworkFetchRequest, state: InterceptorState) => {
      state.stats.globalSucCount++;
      return {
        blob: "ok",
        headers: {},
        status: 200,
        retryTimes: 0,
        globalSucCount: 99,
      };
    });

    const response = await new NetworkInterceptorPipeline().run(request, createState(), executor);

    expect(response.globalSucCount).toBe(1);
  });

  it("runs onResponse hooks with the merged, mutable response", async () => {
    const seen: NetworkFetchResponse[] = [];
    const pipeline = new NetworkInterceptorPipeline().use({
      name: "observer",
      onRequest: () => {},
      onResponse: ({ response, synthetic }) => {
        expect(synthetic).toBe(false);
        response.retryTimes = 3;
        seen.push(response);
      },
    });

    const response = await pipeline.run(request, createState(), createExecutor());

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(response);
    expect(response.retryTimes).toBe(3);
  });

  it("exposes the executor through ctx.execute", async () => {
    const executor = createExecutor();
    const pipeline = new NetworkInterceptorPipeline().use({
      name: "rewriter",
      onRequest: async (ctx) => {
        const result = await ctx.execute({
          ...ctx.request,
          url: "https://music.163.com/api/other",
        });
        ctx.respondWith(result);
      },
    });

    const response = await pipeline.run(request, createState(), executor);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0].url).toBe("https://music.163.com/api/other");
    expect(response.blob).toBe('{"code":200}');
  });

  it("reuses the result of ctx.execute instead of executing again", async () => {
    const executor = createExecutor();
    const pipeline = new NetworkInterceptorPipeline().use({
      name: "observer",
      onRequest: async (ctx) => {
        const result = await ctx.execute();
        expect(result.blob).toBe('{"code":200}');
      },
    });

    const response = await pipeline.run(request, createState(), executor);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(response.blob).toBe('{"code":200}');
  });

  it("uses the last execution when an interceptor executes more than once", async () => {
    const executor = vi.fn(async (req: NetworkFetchRequest) => ({
      blob: req.url,
      headers: {},
      status: 200,
      retryTimes: 0,
    }));
    const pipeline = new NetworkInterceptorPipeline().use({
      name: "retrier",
      onRequest: async (ctx) => {
        await ctx.execute({ ...ctx.request, url: "https://music.163.com/api/first" });
        await ctx.execute({ ...ctx.request, url: "https://music.163.com/api/second" });
      },
    });

    const response = await pipeline.run(request, createState(), executor);

    expect(executor).toHaveBeenCalledTimes(2);
    expect(response.blob).toBe("https://music.163.com/api/second");
  });

  it("lets a later synthetic response override an earlier execution", async () => {
    const executor = createExecutor();
    const pipeline = new NetworkInterceptorPipeline()
      .use({
        name: "executor",
        onRequest: async (ctx) => {
          await ctx.execute();
        },
      })
      .use({
        name: "override",
        onRequest: ({ respondWith }) => {
          respondWith({ blob: '{"code":204}', status: 200 });
        },
      });

    const response = await pipeline.run(request, createState(), executor);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(response.blob).toBe('{"code":204}');
  });

  it("still fails when an execution rejects and no fallback is set", async () => {
    const executor = vi.fn(async () => {
      throw new Error("boom");
    });
    const pipeline = new NetworkInterceptorPipeline().use({
      name: "observer",
      onRequest: async (ctx) => {
        try {
          await ctx.execute();
        } catch {
          // Swallowing the rejection here must not make the request succeed.
        }
      },
    });

    await expect(pipeline.run(request, createState(), executor)).rejects.toThrow("boom");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("lets respondWith recover from a failed execution", async () => {
    const executor = vi.fn(async () => {
      throw new Error("boom");
    });
    const pipeline = new NetworkInterceptorPipeline().use({
      name: "fallback",
      onRequest: async (ctx) => {
        try {
          await ctx.execute();
        } catch {
          ctx.respondWith({ blob: "{}", status: 200 });
        }
      },
    });

    const response = await pipeline.run(request, createState(), executor);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ blob: "{}", status: 200 });
  });

  it("runs onError hooks in reverse order and rethrows the original error", async () => {
    const order: string[] = [];
    const pipeline = new NetworkInterceptorPipeline()
      .use({
        name: "first",
        onRequest: () => {},
        onError: () => {
          order.push("first");
        },
      })
      .use({
        name: "second",
        onRequest: () => {},
        onError: () => {
          order.push("second");
          throw new Error("hook failure");
        },
      });
    const failing: NetworkExecutor = async () => {
      throw new Error("boom");
    };

    await expect(pipeline.run(request, createState(), failing)).rejects.toThrow("boom");
    expect(order).toEqual(["second", "first"]);
  });
});

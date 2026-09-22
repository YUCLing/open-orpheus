import { describe, expect, it, vi } from "vitest";

import {
  dispatcher,
  registerCallHandler,
  registerCallbackHandler,
} from "@main/calls/dispatcher";

// `src/main/ipc/dispatcher.ts` is a thin wrapper around the shared `CallDispatcher`
// instance. Dispatch semantics themselves are covered by
// `__test__/CallDispatcher.spec.ts`, so only the wiring is tested here.
describe("registerCallHandler", () => {
  it("registers into the shared dispatcher and forwards its arguments", async () => {
    const handler = vi.fn((event: unknown, left: unknown, right: unknown) => [
      event,
      Number(left) + Number(right),
    ]);
    registerCallHandler("test.add", handler);

    const callback = vi.fn();
    await dispatcher.dispatch("test.add", callback, "evt", 1, 2);

    expect(handler).toHaveBeenCalledWith("evt", 1, 2);
    // The returned tuple is spread onto the callback.
    expect(callback).toHaveBeenCalledWith("evt", 3);
  });
});

describe("registerCallbackHandler", () => {
  it("registers a streaming handler that receives the callback", async () => {
    registerCallbackHandler("test.stream", (callback, first, second) => {
      callback(first);
      callback(second);
    });

    const callback = vi.fn();
    await dispatcher.dispatch("test.stream", callback, "a", "b");

    expect(callback).toHaveBeenNthCalledWith(1, "a");
    expect(callback).toHaveBeenNthCalledWith(2, "b");
  });
});

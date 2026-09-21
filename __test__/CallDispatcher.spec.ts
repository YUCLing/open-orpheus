import { describe, expect, it, vi } from "vitest";

import CallDispatcher from "@shared/CallDispatcher";

describe("CallDispatcher", () => {
  it("forwards an array result to the callback as separate arguments", async () => {
    const dispatcher = new CallDispatcher();
    dispatcher.registerHandler("sum", (a, b) => [Number(a) + Number(b)]);

    const callback = vi.fn();
    await dispatcher.dispatch("sum", callback, 1, 2);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(3);
  });

  it("calls the callback with no arguments for a void handler", async () => {
    const dispatcher = new CallDispatcher();
    dispatcher.registerHandler("ping", () => undefined);

    const callback = vi.fn();
    await dispatcher.dispatch("ping", callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith();
  });

  it("ignores non-array results", async () => {
    const dispatcher = new CallDispatcher();
    dispatcher.registerHandler("now", () => "not an array" as never);

    const callback = vi.fn();
    await dispatcher.dispatch("now", callback);

    expect(callback).toHaveBeenCalledWith();
  });

  it("awaits asynchronous handlers", async () => {
    const dispatcher = new CallDispatcher();
    dispatcher.registerHandler("later", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return ["done"];
    });

    const callback = vi.fn();
    await dispatcher.dispatch("later", callback);

    expect(callback).toHaveBeenCalledWith("done");
  });

  it("returns false and leaves the callback untouched for unknown commands", async () => {
    const dispatcher = new CallDispatcher();
    const callback = vi.fn();

    await expect(dispatcher.dispatch("nope", callback)).resolves.toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it("registers many handlers at once", async () => {
    const dispatcher = new CallDispatcher();
    const calls: string[] = [];
    dispatcher.registerHandlers({
      a: () => {
        calls.push("a");
      },
      b: () => {
        calls.push("b");
      },
    });

    const a = vi.fn();
    const b = vi.fn();
    await dispatcher.dispatch("a", a);
    await dispatcher.dispatch("b", b);

    expect(calls).toEqual(["a", "b"]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("lets a later registration override an earlier one", async () => {
    const dispatcher = new CallDispatcher();
    dispatcher.registerHandler("x", () => ["first"]);
    dispatcher.registerHandler("x", () => ["second"]);

    const callback = vi.fn();
    await dispatcher.dispatch("x", callback);

    expect(callback).toHaveBeenCalledWith("second");
  });

  it("prefers a callback handler over a plain handler", async () => {
    const dispatcher = new CallDispatcher();
    dispatcher.registerHandler("cmd", () => ["plain"]);
    dispatcher.registerCallbackHandler("cmd", (callback, arg) => {
      callback("streamed", arg);
    });

    const callback = vi.fn();
    await expect(
      dispatcher.dispatch("cmd", callback, 7)
    ).resolves.toBeUndefined();

    expect(callback).toHaveBeenCalledWith("streamed", 7);
  });

  it("supports asynchronous callback handlers", async () => {
    const dispatcher = new CallDispatcher();
    dispatcher.registerCallbackHandler("cmd", async (callback) => {
      await Promise.resolve();
      callback("async");
    });

    const callback = vi.fn();
    await dispatcher.dispatch("cmd", callback);

    expect(callback).toHaveBeenCalledWith("async");
  });

  it("propagates errors thrown by handlers", async () => {
    const dispatcher = new CallDispatcher();
    dispatcher.registerHandler("boom", () => {
      throw new Error("handler exploded");
    });

    await expect(dispatcher.dispatch("boom", vi.fn())).rejects.toThrow(
      "handler exploded"
    );
  });

  it("does not mistake inherited object properties for handlers", async () => {
    const dispatcher = new CallDispatcher();

    await expect(dispatcher.dispatch("toString", vi.fn())).resolves.toBe(false);
  });
});

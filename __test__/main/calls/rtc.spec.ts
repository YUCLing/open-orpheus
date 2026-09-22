import { describe, expect, it, vi } from "vitest";

import { dispatcher } from "@main/calls";
import { register as registerRtc } from "@main/calls/rtc";

registerRtc();

/** Dispatch a command and return the tuple spread onto the callback. */
async function call(command: string, ...args: unknown[]) {
  const callback = vi.fn();
  // Handlers receive the ipc event as their first argument.
  await dispatcher.dispatch(command, callback, { sender: "test" }, ...args);
  return callback.mock.calls[0] ?? [];
}

describe("rtc calls", () => {
  it("accepts joins and always allows leaving", async () => {
    await expect(call("rtc.enter", { room: "x" })).resolves.toEqual([]);
    await expect(call("rtc.leave")).resolves.toEqual([true]);
  });
});

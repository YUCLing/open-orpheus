import { beforeAll, describe, expect, it, vi } from "vitest";

// Reading an effect touches the pack/data directories, so it is faked here.
const hoisted = vi.hoisted(() => ({ readEffect: vi.fn() }));

vi.mock("../../../src/main/audio", () => ({
  readEffect: hoisted.readEffect,
  default: vi.fn(),
}));

import { NcaeType } from "$sharedTypes/ncae";

import { dispatcher } from "../../../src/main/calls";
import { installLoggerStub } from "../../helpers/globals";

let logger: ReturnType<typeof installLoggerStub>;

beforeAll(async () => {
  logger = installLoggerStub();
  // Importing the module installs the `audioeffect.*` handlers.
  await import("../../../src/main/calls/audioeffect");
});

/** Dispatch a command and return the tuple spread onto the callback. */
async function call(command: string, ...args: unknown[]) {
  const callback = vi.fn();
  // Handlers receive the ipc event as their first argument.
  await dispatcher.dispatch(command, callback, { sender: "test" }, ...args);
  return callback.mock.calls[0] as unknown[];
}

const pathInfo = { path: "audioeffect/a.ncae", pathtype: 2 };
const getParams = () => call("audioeffect.getParams", 0, pathInfo);

describe("audioeffect.getParams", () => {
  it("returns plain text effects as is", async () => {
    hoisted.readEffect.mockResolvedValue('{"wet":1}');

    await expect(getParams()).resolves.toEqual([{ data: '{"wet":1}' }]);
    expect(hoisted.readEffect).toHaveBeenCalledWith(pathInfo);
  });

  it("unwraps the payload of a json effect", async () => {
    hoisted.readEffect.mockResolvedValue({
      header: { payloadSize: 8, type: NcaeType.Json },
      payload: '{"wet":2}',
    });

    await expect(getParams()).resolves.toEqual([{ data: '{"wet":2}' }]);
  });

  it("refuses wav impulses, which the renderer cannot use", async () => {
    hoisted.readEffect.mockResolvedValue({
      header: { payloadSize: 4, type: NcaeType.Wav },
      payload: new Uint8Array([1, 2, 3, 4]),
    });

    await expect(getParams()).resolves.toEqual([
      { errorCode: 2, errorMsg: "Got WAV NCAE" },
    ]);
  });

  it("turns read failures into an error response", async () => {
    hoisted.readEffect.mockRejectedValue(new Error("Illegal path: ../secret"));

    await expect(getParams()).resolves.toEqual([
      { errorCode: 2, errorMsg: "Illegal path: ../secret" },
    ]);
    expect(logger.error).toHaveBeenCalled();
  });
});

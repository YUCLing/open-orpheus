import { beforeAll, describe, expect, it, vi } from "vitest";

import { NcaeType } from "$sharedTypes/ncae";

import { dispatcher } from "@main/ipc/dispatcher";
import { installLoggerStub } from "../../helpers/globals";

const readEffect = vi.fn();

let logger: ReturnType<typeof installLoggerStub>;

beforeAll(async () => {
  logger = installLoggerStub();
  const { register } = await import("@main/ipc/audioeffect");
  register({ audio: { readEffect } });
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
    readEffect.mockResolvedValue('{"wet":1}');

    await expect(getParams()).resolves.toEqual([{ data: '{"wet":1}' }]);
    expect(readEffect).toHaveBeenCalledWith(pathInfo);
  });

  it("unwraps the payload of a json effect", async () => {
    readEffect.mockResolvedValue({
      header: { payloadSize: 8, type: NcaeType.Json },
      payload: '{"wet":2}',
    });

    await expect(getParams()).resolves.toEqual([{ data: '{"wet":2}' }]);
  });

  it("refuses wav impulses, which the renderer cannot use", async () => {
    readEffect.mockResolvedValue({
      header: { payloadSize: 4, type: NcaeType.Wav },
      payload: new Uint8Array([1, 2, 3, 4]),
    });

    await expect(getParams()).resolves.toEqual([
      { errorCode: 2, errorMsg: "Got WAV NCAE" },
    ]);
  });

  it("turns read failures into an error response", async () => {
    readEffect.mockRejectedValue(new Error("Illegal path: ../secret"));

    await expect(getParams()).resolves.toEqual([
      { errorCode: 2, errorMsg: "Illegal path: ../secret" },
    ]);
    expect(logger.error).toHaveBeenCalled();
  });
});

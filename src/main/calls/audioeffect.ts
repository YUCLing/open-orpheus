import { NcaeType } from "$sharedTypes/ncae";
import { toError } from "../../util";
import { readEffect } from "../audio";
import { registerCallHandler } from "../calls";

registerCallHandler<
  [number, { path: string; pathtype: number }],
  [{ data: string } | { errorCode: number; errorMsg: string }]
>("audioeffect.getParams", async (event, num, pathInfo) => {
  try {
    const effect = await readEffect(pathInfo);
    if (typeof effect === "string") {
      return [{ data: effect }];
    }
    if (effect.header.type === NcaeType.Wav) {
      throw new Error("Got WAV NCAE");
    }
    return [{ data: effect.payload as string }];
  } catch (e) {
    const err = toError(e);
    console.error("Failed to get audio effect params:", err);
    return [{ errorCode: 2, errorMsg: err.message }];
  }
});

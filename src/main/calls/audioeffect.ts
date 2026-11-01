import { NcaeType } from "@shared/types/ncae";
import { toError } from "@shared/util";
import { readEffect } from "../audio";
import { registerCallHandler } from "../calls";

registerCallHandler<
  [number, { path: string; pathtype: number }],
  [{ data: string } | { errorCode: number; errorMsg: string }]
>("audioeffect.getParams", async (event, num, pathInfo) => {
  LOGGER.debug({ pathtype: pathInfo.pathtype }, "Audio effect params requested");
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
    LOGGER.error({ err }, "Failed to get audio effect params");
    return [{ errorCode: 2, errorMsg: err.message }];
  }
});

type ModelParam = {
  name: string;
  dtype: string;
  shape: unknown[];
};
type ModelInput = ModelParam & {
  data: unknown[];
};
registerCallHandler<
  [
    {
      modelId: string;
      inputs: ModelInput[];
      outputNames: string[];
      signature: {
        modelId: string;
        inputs: ModelInput[];
        outputs: ModelParam[];
      };
    },
  ],
  [
    {
      errorCode: number;
      errorMsg: string;
    },
  ]
>("audioeffect.predictEmoFX", () => {
  return [
    {
      errorCode: -111,
      errorMsg: "model not loaded",
    },
  ];
});

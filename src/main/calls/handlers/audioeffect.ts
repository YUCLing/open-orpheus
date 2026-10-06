import { NcaeType } from "@shared/types/ncae";
import { toError } from "@shared/util";
import { registerCallHandler } from "../dispatcher";

export interface AudioeffectDeps {
  audio: { readEffect: typeof import("../../services/audio").readEffect };
}

type ModelParam = {
  name: string;
  dtype: string;
  shape: unknown[];
};
type ModelInput = ModelParam & {
  data: unknown[];
};

export function register(deps: AudioeffectDeps): void {
  registerCallHandler<
    [number, { path: string; pathtype: number }],
    [{ data: string } | { errorCode: number; errorMsg: string }]
  >("audioeffect.getParams", async (event, num, pathInfo) => {
    try {
      const effect = await deps.audio.readEffect(pathInfo);
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
}

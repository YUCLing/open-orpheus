/// <reference types="@types/audioworklet" />

import { initSync, test } from "@open-orpheus/audio-effect";

class AudioEffectProcessor extends AudioWorkletProcessor {
  constructor(options?: AudioWorkletNodeOptions) {
    super();

    const { wasmModule } = (options?.processorOptions ?? {}) as {
      wasmModule?: WebAssembly.Module;
    };

    if (wasmModule) {
      initSync({ module: wasmModule });
      console.log("WASM value:", test());
    } else {
      console.error("audio-effect: no wasmModule in processorOptions");
    }
  }

  process(): boolean {
    return true;
  }
}

registerProcessor("audio-effect", AudioEffectProcessor);

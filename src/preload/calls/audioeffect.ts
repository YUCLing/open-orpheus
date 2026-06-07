import { ipcRenderer } from "electron";

import { Ncae, NcaeType } from "$sharedTypes/ncae";

import { player } from "../audioplayer";
import { registerCallHandler } from "../calls";

type EqualizerData = {
  eq: {
    on: boolean;
    eqs: [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
  };
  bt: {
    on: boolean;
    bass: number;
    treble: number;
  };
  rvb: {
    on: boolean;
    er: {
      on: boolean;
      pattern: number;
      rsize: number;
      sdelay: number;
    };
    rvb: {
      pdelay: number;
      dtime: number;
      hfdamping: number;
      density: number;
      rshape: number;
      q: number;
      diffusion: number;
      swidth: number;
    };
    tc: {
      on: boolean;
      f: {
        band: number;
        insert: number;
        curve: number;
        gain: number;
        freq: number;
        q: number;
      }[];
    };
    il: {
      center: number;
      lfe: number;
    };
    rl: {
      front: number;
      rear: number;
      center: number;
      lfe: number;
    };
    ol: {
      dry: number;
      er: number;
      rvb: number;
    };
  };
  se: {
    on: boolean;
    presence: number;
    stereoizer: number;
    sshaper: boolean;
    ambience: number;
  };
  rotate: {
    on: boolean;
    velocity: number;
  };
  peq: {
    on: boolean;
    gain: number;
    f: {
      band: number;
      on: boolean;
      freq: number;
      gain: number;
      q: number;
      type: number;
    }[];
  };
  limiter: {
    on: boolean;
  };
  cmp: {
    on: boolean;
  };
};

function applyEqualizer(eq: string) {
  try {
    const equalizer = JSON.parse(eq) as EqualizerData;
    player.setAudioEffectEnabled(true);
    const effectManager = player.audioEffectManager;
    if (equalizer.eq.on) {
      effectManager.setEqualizers(equalizer.eq.eqs);
    } else {
      effectManager.setEqualizers(null);
    }
    if (equalizer.bt.on) {
      effectManager.setBass(equalizer.bt.bass);
      effectManager.setTreble(equalizer.bt.treble);
    } else {
      effectManager.setBass(0);
      effectManager.setTreble(0);
    }
  } catch (err) {
    console.error("Failed to apply audio effect", err);
  }
}

registerCallHandler<
  [
    number,
    {
      path: string;
      pathtype: number;
    },
    boolean,
    string | null,
  ],
  void
>("audioeffect.setParams", async (argCount, path, enabled, eqData) => {
  if (!enabled) {
    player.setAudioEffectEnabled(false);
    return;
  }
  const rawEqualizerData: null | string | Ncae =
    (await ipcRenderer.invoke("audio.readEffect", path)) ?? eqData;
  if (!rawEqualizerData) return;

  if (typeof rawEqualizerData === "string") {
    applyEqualizer(rawEqualizerData);
    return;
  }

  if (rawEqualizerData.header.type === NcaeType.Json) {
    applyEqualizer(rawEqualizerData.payload as string);
  } else {
    console.warn("WAV audio effect is not yet supported");
  }
});

registerCallHandler<[boolean], void>("audioeffect.setLoudnessON", () => {
  console.warn("audioeffect.setLoudnessON is not implemented yet.");
});

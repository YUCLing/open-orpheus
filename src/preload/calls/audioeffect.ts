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

function applyEqualizer(eq: string | null = null) {
  const effectManager = player.audioEffectManager;
  try {
    if (!eq) throw "DISABLE_EQ";
    const equalizer = JSON.parse(eq) as EqualizerData;
    player.setAudioEffectEnabled(true);
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
    if (err !== "DISABLE_EQ")
      console.error("Failed to apply audio effect", err);
    effectManager.setEqualizers(null);
    effectManager.setBass(0);
    effectManager.setTreble(0);
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
>("audioeffect.setParams", async (argCount, path, enabled, fallbackEqData) => {
  if (!enabled) {
    player.setAudioEffectEnabled(false);
    return;
  }
  let eqData = fallbackEqData ?? null;
  let wavIr: Uint8Array | null = null;

  const audioEffect: null | string | Ncae = await ipcRenderer.invoke(
    "audio.readEffect",
    path
  );

  if (audioEffect) {
    if (typeof audioEffect === "string") {
      eqData = audioEffect;
    } else if (audioEffect.header.type === NcaeType.Json) {
      eqData = audioEffect.payload as string;
    } else {
      // TODO: Implement reverb
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      wavIr = audioEffect.payload as Uint8Array;
    }
  }

  applyEqualizer(eqData);
});

registerCallHandler<[boolean], void>("audioeffect.setLoudnessON", () => {
  console.warn("audioeffect.setLoudnessON is not implemented yet.");
});

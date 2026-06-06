import { ipcRenderer } from "electron";
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
};

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
  // We don't know what ncae is, always assume it's equalizer data now.
  const rawEqualizerData =
    (await ipcRenderer.invoke("audio.readEffect", path)) ?? eqData;
  if (!rawEqualizerData) return;
  try {
    const equalizer = JSON.parse(rawEqualizerData) as EqualizerData;
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
});

registerCallHandler<[boolean], void>("audioeffect.setLoudnessON", () => {
  console.warn("audioeffect.setLoudnessON is not implemented yet.");
});

import { ipcRenderer } from "electron";

import { Ncae, NcaeType } from "$sharedTypes/ncae";

import { player } from "../audioplayer";
import { registerCallHandler } from "../calls";
import { dbToGain } from "../../util";

type EqualizerData = {
  /** 10-band graphic equalizer. */
  eq: {
    on: boolean;
    /** Gains in dB for bands: [31,63,125,250,500,1k,2k,4k,8k,16k] Hz */
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
  /** Bass / Treble shelving filters. */
  bt: {
    on: boolean;
    /** Low-shelf gain in dB (cutoff ~250 Hz).  Range: -10 … +10 */
    bass: number;
    /** High-shelf gain in dB (cutoff ~4 kHz).  Range: -10 … +10 */
    treble: number;
  };
  /** Reverb system. */
  rvb: {
    on: boolean;
    /** Early reflections (multi-tap delay) */
    er: {
      on: boolean;
      /** Reflection pattern: 15=generic, 23=room, 24=bathroom */
      pattern: number;
      /** Room size parameter.  Range: ~50 … 100 */
      rsize: number;
      /** Start delay in ms.  Default: 40 */
      sdelay: number;
    };
    /** Late reverb tail (FDN) */
    rvb: {
      /** Pre-delay in ms.  Range: 0 … 130.  Default: 25 */
      pdelay: number;
      /** Decay time T60 in seconds.  Range: ~1.2 … 3.6.  Default: 1.2 */
      dtime: number;
      /** High-frequency damping coefficient.  Range: 2 … 3.5.  Default: 2.25 */
      hfdamping: number;
      /** Echo density (%).  Range: 60 … 80.  Default: 80 */
      density: number;
      /** Room shape parameter.  Range: 40 … 100.  Default: 100 */
      rshape: number;
      /** Processing quality / modal density.  Range: 6 … 8.  Default: 8 */
      q: number;
      /** Diffusion amount (%).  Range: 40 … 80.  Default: 100 */
      diffusion: number;
      /** Stereo width.  Range: ~110 … 180.  Default: 180 */
      swidth: number;
    };
    /** Tone control — 3-band parametric EQ applied to reverb wet signal */
    tc: {
      on: boolean;
      f: {
        /** Band number: 1, 2, or 3 (1-based) */
        band: number;
        /** Insert position (always 3 = post-reverb) */
        insert: number;
        /** Filter curve: 0=peaking, 1=lowshelf, 2=highshelf */
        curve: number;
        /** Gain in dB */
        gain: number;
        /** Frequency in Hz */
        freq: number;
        /** Q factor (bandwidth) */
        q: number;
      }[];
    };
    /** Input levels (surround routing) */
    il: {
      /** Center channel input level */
      center: number;
      /** LFE channel input level */
      lfe: number;
    };
    /** Return levels (surround routing) */
    rl: {
      /** Front channel return level */
      front: number;
      /** Rear channel return level */
      rear: number;
      /** Center channel return level */
      center: number;
      /** LFE channel return level */
      lfe: number;
    };
    /** Output mix levels (dry / early reflections / reverb tail) */
    ol: {
      /** Dry (direct) signal level in dB.  Fixed: 0 */
      dry: number;
      /** Early reflections mix level in dB.  Range: -30 … -3 */
      er: number;
      /** Reverb tail mix level in dB.  Range: -25 … -17 */
      rvb: number;
    };
  };
  /** Spatial enhancer (surround). */
  se: {
    on: boolean;
    /** Presence / surround depth.  Range: 0 … 10 */
    presence: number;
    /** Stereo width enhancement.  Range: 0 … 10 */
    stereoizer: number;
    /** Stereo shaper (Haas delay) enable */
    sshaper: boolean;
    /** Ambience coefficient.  Integer.  Typical value: 1 (neutral).  Range: 1 … 4. */
    ambience: number;
  };
  /** Stereo rotation effect. */
  rotate: {
    on: boolean;
    /** Rotation speed / amount.  Default: 20.0 */
    velocity: number;
  };
  /**
   * Parametric equalizer (9-band).
   * Extension beyond the original 5-key format.
   */
  peq: {
    on: boolean;
    /** Overall PEQ output gain in dB */
    gain: number;
    f: {
      /** Band index: 0 … 8 */
      band: number;
      /** Whether this band is active */
      on: boolean;
      /** Center frequency in Hz */
      freq: number;
      /** Gain in dB */
      gain: number;
      /** Q factor (bandwidth) */
      q: number;
      /** Filter type: 0=peaking, 1=lowshelf, 2=highshelf */
      type: number;
    }[];
  };
  /**
   * Peak limiter (brickwall).
   * Extension beyond the original 5-key format.
   */
  limiter: {
    on: boolean;
  };
  /**
   * Dynamics compressor.
   * Extension beyond the original 5-key format.
   */
  cmp: {
    on: boolean;
  };
};

function normalizeWorkletParams(e: EqualizerData) {
  const rvb = e.rvb?.on
    ? {
        on: true,
        er: {
          on: e.rvb.er?.on ?? false,
          pattern: e.rvb.er?.pattern ?? 15,
          rsize: e.rvb.er?.rsize ?? 75,
          sdelay: e.rvb.er?.sdelay ?? 40,
        },
        rvb: {
          pdelay: e.rvb.rvb?.pdelay ?? 25,
          dtime: e.rvb.rvb?.dtime ?? 1.2,
          hfdamping: e.rvb.rvb?.hfdamping ?? 2.25,
          density: e.rvb.rvb?.density ?? 80,
          rshape: e.rvb.rvb?.rshape ?? 100,
          q: e.rvb.rvb?.q ?? 8,
          diffusion: e.rvb.rvb?.diffusion ?? 100,
          swidth: e.rvb.rvb?.swidth ?? 180,
        },
        tc: {
          on: e.rvb.tc?.on ?? false,
          f: (e.rvb.tc?.f ?? []).map((b) => ({
            band: b.band,
            curve: b.curve,
            gain: b.gain,
            freq: b.freq,
            q: b.q,
          })),
        },
        il: {
          center: e.rvb.il?.center ?? 0,
          lfe: e.rvb.il?.lfe ?? 0,
        },
        rl: {
          front: e.rvb.rl?.front ?? 0,
          rear: e.rvb.rl?.rear ?? 0,
          center: e.rvb.rl?.center ?? 0,
          lfe: e.rvb.rl?.lfe ?? 0,
        },
        ol: {
          dry: e.rvb.ol?.dry ?? 0,
          er: e.rvb.ol?.er ?? -14,
          rvb: e.rvb.ol?.rvb ?? -20,
        },
      }
    : null;

  const se = e.se?.on
    ? {
        on: true,
        presence: e.se.presence ?? 0,
        stereoizer: e.se.stereoizer ?? 0,
        sshaper: e.se.sshaper ?? false,
        ambience: e.se.ambience ?? 1,
      }
    : null;

  const rotate = e.rotate?.on
    ? {
        on: true,
        velocity: e.rotate.velocity ?? 20,
      }
    : null;

  return { rvb, se, rotate };
}

function applyEqualizer(eq: string | null = null) {
  const m = player.audioEffectManager;
  try {
    if (!eq) throw "DISABLE_EQ";
    const e = JSON.parse(eq) as EqualizerData;

    // ── Graphic EQ ──────────────────────────────────────
    if (e.eq?.on) {
      m.setEqualizers(e.eq.eqs);
    } else {
      m.setEqualizers(null);
    }

    // ── Bass / Treble ───────────────────────────────────
    if (e.bt?.on) {
      m.setBass(e.bt.bass);
      m.setTreble(e.bt.treble);
    } else {
      m.setBass(0);
      m.setTreble(0);
    }

    // ── PEQ (config → bands; [] = bypass) ───────────────
    if (e.peq?.on) {
      m.setPeqGain(e.peq.gain ?? 0);
      m.setPeqBands(
        (e.peq.f ?? [])
          .filter((b) => b.on)
          .map((b) => ({
            band: b.band,
            freq: b.freq,
            gain: b.gain,
            q: b.q,
            type: b.type,
          }))
      );
    } else {
      m.setPeqGain(0);
      m.setPeqBands([]);
    }

    // ── Compressor / Limiter ────────────────────────────
    m.setCompressorEnabled(e.cmp?.on ?? false);
    m.setLimiterEnabled(e.limiter?.on ?? false);

    const workletParams = normalizeWorkletParams(e);
    m.postWorkletMessage({ module: "setParams", params: workletParams });
    m.setWorkletActive(
      Boolean(workletParams.rvb || workletParams.se || workletParams.rotate)
    );
  } catch (err) {
    if (err !== "DISABLE_EQ")
      console.error("Failed to apply audio effect", err);
    m.setEqualizers(null);
    m.setBass(0);
    m.setTreble(0);
    m.setPeqGain(0);
    m.setPeqBands([]);
    m.setCompressorEnabled(false);
    m.setLimiterEnabled(false);
    m.postWorkletMessage({
      module: "setParams",
      params: { rvb: null, se: null, rotate: null },
    });
    m.setWorkletActive(false);
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
>("audioeffect.setParams", async (argCount, path, enabled, eqDataOverride) => {
  if (!enabled) {
    applyEqualizer(null);
    player.audioEffectManager.clearConvolutionIR();
    player.audioEffectManager.setEnabled(false);
    return;
  }
  let eqData = null;
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
      wavIr = audioEffect.payload as Uint8Array;
    }
  }

  if (eqDataOverride) eqData = eqDataOverride;

  if (eqData || wavIr) {
    player.audioEffectManager.setEnabled(true);
    applyEqualizer(eqData);
    if (wavIr) {
      void player.audioEffectManager.setConvolutionIR(wavIr);
    } else {
      player.audioEffectManager.clearConvolutionIR();
    }
  } else {
    applyEqualizer(null);
    player.audioEffectManager.clearConvolutionIR();
    player.audioEffectManager.setEnabled(false);
  }
});

let loudnessGainEnabled = false;
let loudnessGainDb = 0;
registerCallHandler<[boolean], void>("audioeffect.setLoudnessON", (enabled) => {
  loudnessGainEnabled = enabled;
  if (enabled) {
    player.replayGain.gain.value = dbToGain(loudnessGainDb);
  } else {
    player.replayGain.gain.value = 1;
  }
});

registerCallHandler<[{ gain: number }], void>(
  "audioeffect.setLoudnessParams",
  (params) => {
    const { gain } = params;
    loudnessGainDb = gain / 10000;
    if (loudnessGainEnabled) {
      player.replayGain.gain.value = dbToGain(loudnessGainDb);
    }
  }
);

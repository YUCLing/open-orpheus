/// <reference types="@types/audioworklet" />

import "./helpers/MockTextDecoder";
import {
  initSync,
  FdnReverb,
  EarlyReflections,
  SpatialEnhancer,
} from "@open-orpheus/audio-effect";

// #region Type definitions

interface RotateState {
  on: boolean;
  velocity: number;
  phase: number;
}

interface RvbParams {
  on: boolean;
  er: { on: boolean; pattern: number; rsize: number; sdelay: number };
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
    f: TcBandParams[];
  };
  il: { center: number; lfe: number };
  rl: { front: number; rear: number; center: number; lfe: number };
  ol: { dry: number; er: number; rvb: number };
}

interface TcBandParams {
  band: number;
  curve: number;
  gain: number;
  freq: number;
  q: number;
}

interface SeParams {
  on: boolean;
  presence: number;
  stereoizer: number;
  sshaper: boolean;
  ambience: number;
}

interface RotateParams {
  on: boolean;
  velocity: number;
}

// #endregion

// #region AudioEffectProcessor

class AudioEffectProcessor extends AudioWorkletProcessor {
  // WASM DSP instances
  private fdn: FdnReverb | null = null;
  private er: EarlyReflections | null = null;
  private se: SpatialEnhancer | null = null;

  // Rotation state
  private rotate: RotateState = { on: false, velocity: 20.0, phase: 0 };

  // Cached param state
  private rvbParams: RvbParams | null = null;
  private seParams: SeParams | null = null;

  // Buffer for ER / FDN wet outputs (reused each block)
  private wetBufL = new Float32Array(128);
  private wetBufR = new Float32Array(128);
  private lateBufL = new Float32Array(128);
  private lateBufR = new Float32Array(128);
  private reverbInBufL = new Float32Array(128);
  private reverbInBufR = new Float32Array(128);
  private rvbTcFilters: WorkletBiquad[] = [];
  private rvbTcEnabled = false;

  // Dry / ER / RVB gains (dB → linear, cached)
  private dryGain = 1.0;
  private erGain = 0.0;
  private rvbGain = 0.0;
  private rvbInputGain = 1.0;
  private rvbReturnGain = 1.0;

  // Whether worklet is actively processing effects
  private active = false;

  constructor(options?: AudioWorkletNodeOptions) {
    super();

    const { wasmModule } = (options?.processorOptions ?? {}) as {
      wasmModule?: WebAssembly.Module;
    };

    if (!wasmModule) {
      console.error("audio-effect: no wasmModule in processorOptions");
      return;
    }

    try {
      initSync({ module: wasmModule });

      const sr = sampleRate as number;
      this.fdn = new FdnReverb(sr);
      this.er = new EarlyReflections(sr);
      this.se = new SpatialEnhancer(sr);
      this.rvbTcFilters = [
        new WorkletBiquad(sr),
        new WorkletBiquad(sr),
        new WorkletBiquad(sr),
      ];
    } catch (err) {
      console.error("audio-effect: WASM init failed", err);
    }

    // #region MessagePort
    this.port.onmessage = (e: MessageEvent) => {
      const { module, params } = e.data ?? {};
      if (module === "setParams") {
        this.applyParams(params);
      }
    };
  }

  // #endregion

  // #region Apply parameter updates

  private applyParams(
    params: {
      rvb?: RvbParams | null;
      se?: SeParams | null;
      rotate?: RotateParams | null;
    } = {}
  ): void {
    this.active = false;

    // #region Reverb
    if (params.rvb?.on) {
      if (!this.fdn || !this.er) {
        console.warn("audio-effect: reverb requested but WASM not available");
      }
    }
    if (params.rvb?.on && this.fdn && this.er) {
      this.rvbParams = params.rvb;
      this.active = true;

      const fdn = this.fdn!;
      fdn.set_decay(params.rvb.rvb.dtime);
      fdn.set_hf_damping(params.rvb.rvb.hfdamping);
      fdn.set_density(params.rvb.rvb.density);
      fdn.set_diffusion(params.rvb.rvb.diffusion);
      fdn.set_rshape(params.rvb.rvb.rshape);
      fdn.set_swidth(params.rvb.rvb.swidth);
      fdn.set_pre_delay(params.rvb.rvb.pdelay);
      fdn.set_q(params.rvb.rvb.q);

      this.er!.set_pattern(params.rvb.er.pattern, params.rvb.er.rsize);
      this.er!.set_sdelay(params.rvb.er.sdelay);

      this.dryGain = dbToGain(params.rvb.ol.dry);
      this.erGain = params.rvb.er.on ? dbToGain(params.rvb.ol.er) : 0;
      this.rvbGain = dbToGain(params.rvb.ol.rvb);
      this.rvbInputGain = dbToGain(
        ((params.rvb.il?.center ?? 0) + (params.rvb.il?.lfe ?? 0)) / 2
      );
      this.rvbReturnGain = dbToGain(
        ((params.rvb.rl?.front ?? 0) + (params.rvb.rl?.rear ?? 0)) / 2
      );
      this.configureRvbTc(params.rvb.tc);
    } else {
      this.rvbParams = null;
      this.dryGain = 1.0;
      this.erGain = 0.0;
      this.rvbGain = 0.0;
      this.rvbInputGain = 1.0;
      this.rvbReturnGain = 1.0;
      this.configureRvbTc(null);
    }

    // #endregion

    // #region Spatial Enhancement
    if (params.se?.on && !this.se) {
      console.warn(
        "audio-effect: spatial enhancer requested but WASM not available"
      );
    }
    if (params.se?.on && this.se) {
      this.seParams = params.se;
      this.active = true;

      const se = this.se!;
      se.set_presence(params.se.presence);
      se.set_stereoizer(params.se.stereoizer);
      se.set_sshaper(params.se.sshaper, sampleRate as number);
      se.set_ambience(params.se.ambience);
    } else {
      this.seParams = null;
    }

    // #endregion

    // #region Rotation
    if (params.rotate?.on) {
      this.rotate.on = true;
      this.rotate.velocity = params.rotate.velocity;
      this.active = true;
    } else {
      this.rotate.on = false;
    }
    // #endregion
  }

  // #endregion

  // #region Audio processing callback

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || !input[0] || !output[0]) return true;

    const inL = input[0];
    const inR = input.length > 1 ? input[1] : inL;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : outL;
    const n = Math.min(inL.length, outL.length);

    // Fast path: no effects → passthrough
    if (!this.active) {
      for (let i = 0; i < n; i++) {
        outL[i] = inL[i];
        outR[i] = inR[i];
      }
      return true;
    }

    // Ensure wet buffers can hold this block size
    if (this.wetBufL.length < n) {
      this.wetBufL = new Float32Array(n);
      this.wetBufR = new Float32Array(n);
      this.lateBufL = new Float32Array(n);
      this.lateBufR = new Float32Array(n);
      this.reverbInBufL = new Float32Array(n);
      this.reverbInBufR = new Float32Array(n);
    }

    // #region SE: spatial enhancement
    for (let i = 0; i < n; i++) {
      outL[i] = inL[i];
      outR[i] = inR[i];
    }
    if (this.seParams?.on) {
      this.se!.process_block(
        outL.subarray(0, n) as Float32Array,
        outR.subarray(0, n) as Float32Array
      );
    }

    // #endregion

    // #region Rotation feed
    if (this.rotate.on) {
      this.applyRotation(outL, outR, n);
    }

    if (this.rvbParams?.on) {
      for (let i = 0; i < n; i++) {
        this.reverbInBufL[i] = outL[i] * this.rvbInputGain;
        this.reverbInBufR[i] = outR[i] * this.rvbInputGain;
      }
    }

    // #endregion

    // #region ER: early reflections
    if (this.rvbParams?.er.on && this.erGain > 0.001) {
      this.er!.process_block(
        this.reverbInBufL.subarray(0, n) as Float32Array,
        this.reverbInBufR.subarray(0, n) as Float32Array,
        this.wetBufL.subarray(0, n) as Float32Array,
        this.wetBufR.subarray(0, n) as Float32Array
      );
    } else {
      this.wetBufL.fill(0, 0, n);
      this.wetBufR.fill(0, 0, n);
    }

    // #endregion

    // #region FDN: late reverb
    if (this.rvbParams?.rvb && this.rvbGain > 0.001) {
      this.fdn!.process_block(
        this.reverbInBufL.subarray(0, n) as Float32Array,
        this.reverbInBufR.subarray(0, n) as Float32Array,
        this.lateBufL.subarray(0, n) as Float32Array,
        this.lateBufR.subarray(0, n) as Float32Array
      );
      // Accumulate: wet = ER * erGain + FDN * rvbGain
      for (let i = 0; i < n; i++) {
        this.wetBufL[i] =
          this.wetBufL[i] * this.erGain + this.lateBufL[i] * this.rvbGain;
        this.wetBufR[i] =
          this.wetBufR[i] * this.erGain + this.lateBufR[i] * this.rvbGain;
      }
    } else {
      for (let i = 0; i < n; i++) {
        this.wetBufL[i] *= this.erGain;
        this.wetBufR[i] *= this.erGain;
      }
    }

    if (this.rvbParams?.on) {
      for (let i = 0; i < n; i++) {
        this.wetBufL[i] *= this.rvbReturnGain;
        this.wetBufR[i] *= this.rvbReturnGain;
      }
      if (this.rvbTcEnabled) {
        for (const filter of this.rvbTcFilters) {
          filter.processBlock(this.wetBufL, this.wetBufR, n);
        }
      }
    }

    // #endregion

    // #region Mix dry + wet
    for (let i = 0; i < n; i++) {
      outL[i] = outL[i] * this.dryGain + this.wetBufL[i];
      outR[i] = outR[i] * this.dryGain + this.wetBufR[i];
    }

    // #endregion

    return true;
  }

  // #endregion

  // #region Stereo rotation

  private applyRotation(l: Float32Array, r: Float32Array, n: number): void {
    const sr = sampleRate as number;
    const freq = this.rotate.velocity / 60.0; // velocity → Hz
    const phaseInc = (2 * Math.PI * freq) / sr;

    for (let i = 0; i < n; i++) {
      const cos = Math.cos(this.rotate.phase);
      const sin = Math.sin(this.rotate.phase);

      const li = l[i];
      const ri = r[i];
      l[i] = li * cos - ri * sin;
      r[i] = li * sin + ri * cos;

      this.rotate.phase += phaseInc;
      if (this.rotate.phase > 2 * Math.PI) {
        this.rotate.phase -= 2 * Math.PI;
      }
    }
  }

  // #endregion

  // #region Tone control

  private configureRvbTc(tc: RvbParams["tc"] | null): void {
    this.rvbTcEnabled = Boolean(tc?.on);
    for (const filter of this.rvbTcFilters) {
      filter.setBypass();
    }

    if (!tc?.on) return;

    for (const band of tc.f ?? []) {
      const idx = band.band - 1;
      if (idx < 0 || idx >= this.rvbTcFilters.length) continue;
      this.rvbTcFilters[idx].setParams(
        band.curve,
        band.freq,
        band.gain,
        band.q
      );
    }
  }

  // #endregion
}

// #endregion

// #region Utility

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// #endregion

// #region WorkletBiquad

class WorkletBiquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1L = 0;
  private z2L = 0;
  private z1R = 0;
  private z2R = 0;

  constructor(private readonly sr: number) {}

  setBypass(): void {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.reset();
  }

  setParams(curve: number, freq: number, gainDb: number, q: number): void {
    const f0 = clamp(freq || 1000, 20, this.sr * 0.45);
    const safeQ = clamp(q || 1, 0.05, 18);
    const w0 = (2 * Math.PI * f0) / this.sr;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const a = 10 ** (gainDb / 40);

    if (curve === 1 || curve === 2) {
      this.setShelf(curve === 2, a, cos, sin, safeQ);
      return;
    }

    const alpha = sin / (2 * safeQ);
    this.setCoefficients(
      1 + alpha * a,
      -2 * cos,
      1 - alpha * a,
      1 + alpha / a,
      -2 * cos,
      1 - alpha / a
    );
  }

  processBlock(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const left = l[i];
      const yl = left * this.b0 + this.z1L;
      this.z1L = left * this.b1 + this.z2L - this.a1 * yl;
      this.z2L = left * this.b2 - this.a2 * yl;
      l[i] = yl;

      const right = r[i];
      const yr = right * this.b0 + this.z1R;
      this.z1R = right * this.b1 + this.z2R - this.a1 * yr;
      this.z2R = right * this.b2 - this.a2 * yr;
      r[i] = yr;
    }
  }

  private setShelf(
    high: boolean,
    a: number,
    cos: number,
    sin: number,
    slope: number
  ): void {
    const sqrtA = Math.sqrt(a);
    const shelfTerm = (a + 1 / a) * (1 / clamp(slope, 0.1, 10) - 1) + 2;
    const alpha = (sin / 2) * Math.sqrt(Math.max(0.000001, shelfTerm));

    if (high) {
      this.setCoefficients(
        a * (a + 1 + (a - 1) * cos + 2 * sqrtA * alpha),
        -2 * a * (a - 1 + (a + 1) * cos),
        a * (a + 1 + (a - 1) * cos - 2 * sqrtA * alpha),
        a + 1 - (a - 1) * cos + 2 * sqrtA * alpha,
        2 * (a - 1 - (a + 1) * cos),
        a + 1 - (a - 1) * cos - 2 * sqrtA * alpha
      );
      return;
    }

    this.setCoefficients(
      a * (a + 1 - (a - 1) * cos + 2 * sqrtA * alpha),
      2 * a * (a - 1 - (a + 1) * cos),
      a * (a + 1 - (a - 1) * cos - 2 * sqrtA * alpha),
      a + 1 + (a - 1) * cos + 2 * sqrtA * alpha,
      -2 * (a - 1 + (a + 1) * cos),
      a + 1 + (a - 1) * cos - 2 * sqrtA * alpha
    );
  }

  private setCoefficients(
    b0: number,
    b1: number,
    b2: number,
    a0: number,
    a1: number,
    a2: number
  ): void {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    this.reset();
  }

  private reset(): void {
    this.z1L = 0;
    this.z2L = 0;
    this.z1R = 0;
    this.z2R = 0;
  }
}

// #endregion

registerProcessor("audio-effect", AudioEffectProcessor);

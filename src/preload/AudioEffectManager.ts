/** 10-band graphic EQ frequencies (fixed, octave-spaced) */
const EQ_FREQUENCIES = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Standard Q for octave-band graphic equalizer */
const EQ_Q = Math.SQRT2;

/** Bass low-shelf cutoff frequency */
const BASS_FREQ = 250;
/** Treble high-shelf cutoff frequency */
const TREBLE_FREQ = 4000;

/** Convert dB to linear gain. */
function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

// ─────────────────────────────────────────────────────────────
//  Slot descriptor used by the node router.
//  Each slot represents an optional effect stage in the chain.
// ─────────────────────────────────────────────────────────────
interface Slot {
  name: string;
  input: AudioNode;
  output: AudioNode;
  active: boolean;
}

/** A PEQ band (0–8). Presence in the `setPeqBands` array = active. */
export interface PeqBand {
  band: number; // 0–8
  freq?: number; // Hz
  gain?: number; // dB
  q?: number;
  type?: number; // 0=peaking, 1=lowshelf, 2=highshelf
}

export default class AudioEffectManager {
  private ctx: AudioContext;

  /** Entry point — external source connects here */
  input: GainNode;
  /** Exit point — connects to destination */
  output: GainNode;

  // #region Effect nodes
  private readonly bassFilter: BiquadFilterNode;
  private readonly trebleFilter: BiquadFilterNode;
  private readonly eqBands: BiquadFilterNode[];
  private readonly eqTail: AudioNode;
  private _workletNode: AudioWorkletNode | null = null;

  // ── Compressor ────────────────────────────────────────
  private readonly compressorNode: DynamicsCompressorNode;

  // ── Limiter ───────────────────────────────────────────
  private readonly limiterNode: DynamicsCompressorNode;

  // ── PEQ (9-band parametric EQ) ────────────────────────
  private readonly peqBands: BiquadFilterNode[];
  private readonly peqTail: AudioNode;
  private readonly peqGainNode: GainNode;

  // ── ReplayGain (per-track loudness normalization) ────
  private readonly replayGainNode: GainNode;
  private _loudnessEnabled = false;
  private _loudnessGainDb = 0;

  // ── Convolution Reverb ────────────────────────────────
  private readonly convolverNode: ConvolverNode;
  private convolverLoadSerial = 0;
  // #endregion

  // #region Router state
  private readonly slots: Slot[];
  private readonly pendingSlotStates = new Map<string, boolean>();
  private readonly _workletPromise: Promise<void>;
  // #endregion

  constructor(ctx: AudioContext) {
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.output = ctx.createGain();

    // ── Bass (low-shelf) ──────────────────────────────────
    this.bassFilter = ctx.createBiquadFilter();
    this.bassFilter.type = "lowshelf";
    this.bassFilter.frequency.value = BASS_FREQ;
    this.bassFilter.gain.value = 0;

    // ── Treble (high-shelf) ───────────────────────────────
    this.trebleFilter = ctx.createBiquadFilter();
    this.trebleFilter.type = "highshelf";
    this.trebleFilter.frequency.value = TREBLE_FREQ;
    this.trebleFilter.gain.value = 0;

    // ── EQ (10-band peaking chain) ────────────────────────
    this.eqBands = EQ_FREQUENCIES.map((freq) => {
      const filter = ctx.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = freq;
      filter.Q.value = EQ_Q;
      filter.gain.value = 0;
      return filter;
    });
    for (let i = 1; i < this.eqBands.length; i++) {
      this.eqBands[i - 1].connect(this.eqBands[i]);
    }
    this.eqTail = this.eqBands[this.eqBands.length - 1];

    // ── Compressor (first in chain, before limiter) ─────
    this.compressorNode = ctx.createDynamicsCompressor();
    this.compressorNode.threshold.value = -24;
    this.compressorNode.knee.value = 30;
    this.compressorNode.ratio.value = 12;
    this.compressorNode.attack.value = 0.005;
    this.compressorNode.release.value = 0.1;

    // ── Limiter (after compressor, brickwall) ───────────
    this.limiterNode = ctx.createDynamicsCompressor();
    this.limiterNode.threshold.value = -1;
    this.limiterNode.knee.value = 0;
    this.limiterNode.ratio.value = 20;
    this.limiterNode.attack.value = 0.001;
    this.limiterNode.release.value = 0.05;

    // ── PEQ (9-band parametric EQ chain) ────────────────
    this.peqBands = Array.from({ length: 9 }, () => {
      const filter = ctx.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = 1000;
      filter.Q.value = 1.0;
      filter.gain.value = 0;
      return filter;
    });
    for (let i = 1; i < this.peqBands.length; i++) {
      this.peqBands[i - 1].connect(this.peqBands[i]);
    }
    this.peqTail = this.peqBands[this.peqBands.length - 1];
    this.peqGainNode = ctx.createGain();
    this.peqGainNode.gain.value = 1;
    this.peqTail.connect(this.peqGainNode);

    // ── ReplayGain (per-track loudness normalization) ──
    this.replayGainNode = ctx.createGain();
    this.replayGainNode.gain.value = 1; // 0 dB (unity)

    // ── Convolution Reverb ──────────────────────────────
    this.convolverNode = ctx.createConvolver();
    this.convolverNode.normalize = false;

    // ── Router: ordered slots (signal flows top→bottom) ──
    this.slots = [
      {
        name: "replaygain",
        input: this.replayGainNode,
        output: this.replayGainNode,
        active: true, // always in the chain
      },
      {
        name: "cmp",
        input: this.compressorNode,
        output: this.compressorNode,
        active: false,
      },
      {
        name: "limiter",
        input: this.limiterNode,
        output: this.limiterNode,
        active: false,
      },
      {
        name: "bass",
        input: this.bassFilter,
        output: this.bassFilter,
        active: false,
      },
      {
        name: "treble",
        input: this.trebleFilter,
        output: this.trebleFilter,
        active: false,
      },
      {
        name: "peq",
        input: this.peqBands[0],
        output: this.peqGainNode,
        active: false,
      },
      {
        name: "eq",
        input: this.eqBands[0],
        output: this.eqTail,
        active: false,
      },
      {
        name: "convolver",
        input: this.convolverNode,
        output: this.convolverNode,
        active: false,
      },
    ];

    // Initial state: all bypassed, input → output
    this.input.connect(this.output);

    // Load the WASM-backed audio-effect worklet asynchronously.
    // Non-fatal on failure — audio still plays without advanced effects.
    this._workletPromise = this._initWorklet();
  }

  /**
   * Resolves when the audio-effect worklet module has been loaded and the
   * AudioWorkletNode is ready.  Safe to await before activating the worklet
   * slot.
   */
  get workletReady(): Promise<void> {
    return this._workletPromise;
  }

  private async _initWorklet(): Promise<void> {
    try {
      // WASM is being bundled because `audio-effect.ts` imports the wasm-bindgen
      // loader, so it'll be available at this URL
      const response = await fetch(
        "audio://worklet/assets/audio_effect_bg.wasm"
      );
      const wasmModule = await WebAssembly.compile(
        await response.arrayBuffer()
      );

      await this.ctx.audioWorklet.addModule("audio://worklet/audio-effect.js");

      this._workletNode = new AudioWorkletNode(this.ctx, "audio-effect", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: "explicit",
        processorOptions: { wasmModule },
      });

      // Append the worklet slot dynamically once the node exists.
      this.addSlot({
        name: "worklet",
        input: this._workletNode,
        output: this._workletNode,
        active: false,
      });
    } catch (err) {
      console.error("Failed to load audio-effect worklet:", err);
      // Non-fatal: audio still works without advanced effects.
    }
  }

  // #region Equalizer

  /**
   * Set the 10-band graphic equalizer.
   *
   * @param eq  Array of 10 gain values (dB), index-mapped to
   *            `[31, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k]` Hz.
   *            Pass `null` to bypass the EQ stage entirely.
   */
  setEqualizers(eq: number[] | null): void {
    if (eq === null) {
      this.setSlotActive("eq", false);
      return;
    }
    for (let i = 0; i < EQ_FREQUENCIES.length; i++) {
      this.eqBands[i].gain.value = eq[i] ?? 0;
    }
    this.setSlotActive("eq", true);
  }

  // #endregion

  // #region Bass / Treble

  /**
   * Set bass gain (low-shelf).
   *
   * @param bass  Gain in dB, range -10 … +10.
   *              Pass `0` to bypass the bass stage.
   */
  setBass(bass: number): void {
    this.bassFilter.gain.value = bass;
    this.setSlotActive("bass", bass !== 0);
  }

  /**
   * Set treble gain (high-shelf).
   *
   * @param treble  Gain in dB, range -10 … +10.
   *                Pass `0` to bypass the treble stage.
   */
  setTreble(treble: number): void {
    this.trebleFilter.gain.value = treble;
    this.setSlotActive("treble", treble !== 0);
  }

  // #endregion

  // #region Worklet (WASM-backed audio effects)

  /**
   * The underlying AudioWorkletNode, or `null` if the module hasn't loaded
   * yet or failed to load.
   */
  get workletNode(): AudioWorkletNode | null {
    return this._workletNode;
  }

  /**
   * Send a parameter update to the audio-effect worklet.
   *
   * Safe to call before the worklet is ready — the message is queued and
   * delivered once the node is available.
   *
   * @param data  Arbitrary structured-cloneable payload forwarded to the
   *              worklet's `port.onmessage` handler.
   */
  postWorkletMessage(data: unknown): void {
    if (this._workletNode) {
      this._workletNode.port.postMessage(data);
    } else {
      // Queue for delivery once the worklet is ready.
      this._workletPromise.then(() => {
        this._workletNode?.port.postMessage(data);
      });
    }
  }

  /**
   * Activate or bypass the WASM worklet slot.
   *
   * Call this whenever worklet-backed effects (SE, rotate, ER, FDN)
   * are enabled or disabled.
   */
  setWorkletActive(on: boolean): void {
    this.setSlotActive("worklet", on);
  }

  // #endregion

  // #region Parametric EQ (PEQ)

  /**
   * Set PEQ bands. Pass `[]` or an empty array to bypass PEQ entirely.
   * Each band's optional fields (`freq`, `gain`, `q`, `type`) preserve
   * the current value when omitted.
   */
  setPeqBands(bands: PeqBand[]): void {
    if (bands.length === 0) {
      this.setSlotActive("peq", false);
      return;
    }

    const typeMap = ["peaking", "lowshelf", "highshelf"] as const;

    // Bypass all bands first, then activate only the ones present.
    for (let i = 0; i < this.peqBands.length; i++) {
      this.peqBands[i].gain.value = 0;
    }

    for (const b of bands) {
      if (b.band < 0 || b.band >= this.peqBands.length) continue;
      const node = this.peqBands[b.band];

      if (b.type !== undefined) node.type = typeMap[b.type] ?? "peaking";
      if (b.freq !== undefined) node.frequency.value = b.freq;
      if (b.gain !== undefined) node.gain.value = b.gain;
      if (b.q !== undefined) node.Q.value = b.q;
    }

    this.setSlotActive("peq", true);
  }

  /** Set overall PEQ output gain in dB. */
  setPeqGain(gainDb: number): void {
    this.peqGainNode.gain.value = dbToGain(gainDb);
  }

  // #endregion

  // #region Compressor

  /** Toggle the dynamics compressor. */
  setCompressorEnabled(on: boolean): void {
    this.compressorNode.ratio.value = on ? 12 : 1;
    this.setSlotActive("cmp", on);
  }

  // #endregion

  // #region ReplayGain / Loudness

  /**
   * Enable or disable per-track loudness normalization (ReplayGain).
   * When disabled, the gain is reset to 0 dB (unity).
   */
  setLoudnessEnabled(on: boolean): void {
    this._loudnessEnabled = on;
    this.replayGainNode.gain.value = on ? dbToGain(this._loudnessGainDb) : 1;
  }

  /**
   * Set the replay gain adjustment for the current track.
   *
   * @param gain  Scaled integer; divide by 10000 to get dB.
   *              Example: -49869 → -4.9869 dB.
   */
  setLoudnessGain(gain: number): void {
    this._loudnessGainDb = gain / 10000;
    if (this._loudnessEnabled) {
      this.replayGainNode.gain.value = dbToGain(this._loudnessGainDb);
    }
  }

  // #endregion

  // #region Limiter

  /** Toggle the peak limiter. */
  setLimiterEnabled(on: boolean): void {
    this.limiterNode.ratio.value = on ? 20 : 1;
    this.setSlotActive("limiter", on);
  }

  // #endregion

  // #region Convolution Reverb

  /**
   * Load a WAV impulse response into the convolution reverb.
   *
   * The WAV buffer is decoded asynchronously via `decodeAudioData`.
   * On success, the convolver is activated as an optional FIR effect slot.
   *
   * @param wavBuffer  Raw RIFF/WAVE bytes (e.g. from NCAE type 2 payload).
   */
  async setConvolutionIR(wavBuffer: Uint8Array): Promise<void> {
    const serial = ++this.convolverLoadSerial;
    try {
      const audioBuffer = await this.ctx.decodeAudioData(
        wavBuffer.buffer.slice(
          wavBuffer.byteOffset,
          wavBuffer.byteOffset + wavBuffer.byteLength
        ) as ArrayBuffer
      );
      if (serial !== this.convolverLoadSerial) return;
      this.convolverNode.normalize = false;
      this.convolverNode.buffer = audioBuffer;
      this.setSlotActive("convolver", true);
    } catch (err) {
      if (serial !== this.convolverLoadSerial) return;
      console.error("Failed to decode convolution IR:", err);
      this.clearConvolutionIR();
    }
  }

  /** Remove the current convolution impulse response. */
  clearConvolutionIR(): void {
    this.convolverLoadSerial++;
    this.convolverNode.buffer = null;
    this.setSlotActive("convolver", false);
  }

  // #endregion

  // #region Node router

  /** Toggle a slot. Rebuilds the chain only when the active state actually changes. */
  private setSlotActive(name: string, active: boolean): void {
    const slot = this.slots.find((s) => s.name === name);
    if (!slot) {
      this.pendingSlotStates.set(name, active);
      return;
    }
    if (slot.active === active) return;

    slot.active = active;
    this.rebuildChain();
  }

  private addSlot(slot: Slot): void {
    const pending = this.pendingSlotStates.get(slot.name);
    if (pending !== undefined) {
      slot.active = pending;
      this.pendingSlotStates.delete(slot.name);
    }

    this.slots.push(slot);
    if (slot.active) {
      this.rebuildChain();
    }
  }

  /**
   * Rebuild the entire effect chain from scratch.
   *
   * Signal flow:
   *   input → [active slots in order] → output
   *
   * When no slots are active the chain is simply input → output.
   */
  private rebuildChain(): void {
    this.input.disconnect();
    for (const slot of this.slots) {
      slot.output.disconnect();
    }

    let prev: AudioNode = this.input;

    for (const slot of this.slots) {
      if (slot.active) {
        prev.connect(slot.input);
        prev = slot.output;
      }
    }

    prev.connect(this.output);
  }

  // #endregion
}

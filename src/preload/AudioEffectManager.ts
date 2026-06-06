/** 10-band graphic EQ frequencies (fixed, octave-spaced) */
const EQ_FREQUENCIES = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Standard Q for octave-band graphic equalizer */
const EQ_Q = Math.SQRT2;

/** Bass low-shelf cutoff frequency */
const BASS_FREQ = 250;
/** Treble high-shelf cutoff frequency */
const TREBLE_FREQ = 4000;

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
  // #endregion

  // #region Router state
  private readonly slots: Slot[];
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

    // ── Router: ordered slots (signal flows top→bottom) ──
    this.slots = [
      {
        name: "bass",
        input: this.bassFilter,
        output: this.bassFilter,
        active: false,
      },
      {
        name: "eq",
        input: this.eqBands[0],
        output: this.eqTail,
        active: false,
      },
      {
        name: "treble",
        input: this.trebleFilter,
        output: this.trebleFilter,
        active: false,
      },
    ];

    // Initial state: all bypassed, input → output
    this.input.connect(this.output);
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

  // #region Node router

  /** Toggle a slot. Rebuilds the chain only when the active state actually changes. */
  private setSlotActive(name: string, active: boolean): void {
    const slot = this.slots.find((s) => s.name === name);
    if (!slot || slot.active === active) return;

    slot.active = active;
    this.rebuildChain();
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

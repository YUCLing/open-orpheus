/* tslint:disable */
/* eslint-disable */

export class EarlyReflections {
    free(): void;
    [Symbol.dispose](): void;
    constructor(sample_rate: number);
    /**
     * Process a block of stereo samples.
     *
     * `output_l` / `output_r` receive only the early-reflection contribution.
     */
    process_block(input_l: Float32Array, input_r: Float32Array, output_l: Float32Array, output_r: Float32Array): void;
    /**
     * Configure the early-reflection pattern.
     *
     * Known values:
     *   0  = church,        2  = concert,
     *   4  = live/stage,
     *   15 = generic,       17 = concert hall,
     *   18 = spring/club,   21 = vocal plate,
     *   23 = room,          24 = bathroom,
     *   28 = underpass
     */
    set_pattern(pattern: number, rsize: number): void;
    /**
     * Set the starting delay offset applied to all taps.
     */
    set_sdelay(sdelay_ms: number): void;
}

export class FdnReverb {
    free(): void;
    [Symbol.dispose](): void;
    constructor(sample_rate: number);
    /**
     * Process a block of stereo samples.
     *
     * `input_l` / `input_r`: input frames.
     * `output_l` / `output_r`: wet output only, without dry signal.
     */
    process_block(input_l: Float32Array, input_r: Float32Array, output_l: Float32Array, output_r: Float32Array): void;
    set_decay(dtime: number): void;
    set_density(density: number): void;
    set_diffusion(diffusion: number): void;
    set_hf_damping(damping: number): void;
    set_pre_delay(pdelay_ms: number): void;
    set_q(q: number): void;
    set_rshape(rshape: number): void;
    set_swidth(swidth: number): void;
}

export class SpatialEnhancer {
    free(): void;
    [Symbol.dispose](): void;
    constructor(sample_rate: number);
    /**
     * Process a block of stereo samples in place.
     */
    process_block(input_l: Float32Array, input_r: Float32Array): void;
    /**
     * Set ambience coefficient.
     */
    set_ambience(ambience: number): void;
    /**
     * Set presence (surround depth, 0-10). Controls mid/side balance.
     */
    set_presence(presence: number): void;
    /**
     * Enable/disable stereo shaping (Haas delay).
     */
    set_sshaper(on: boolean, sample_rate: number): void;
    /**
     * Set stereoizer (width expansion, 0-10). Controls side gain boost.
     */
    set_stereoizer(stereoizer: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_fdnreverb_free: (a: number, b: number) => void;
    readonly __wbg_spatialenhancer_free: (a: number, b: number) => void;
    readonly fdnreverb_new: (a: number) => number;
    readonly fdnreverb_process_block: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly fdnreverb_set_decay: (a: number, b: number) => void;
    readonly fdnreverb_set_density: (a: number, b: number) => void;
    readonly fdnreverb_set_diffusion: (a: number, b: number) => void;
    readonly fdnreverb_set_hf_damping: (a: number, b: number) => void;
    readonly fdnreverb_set_pre_delay: (a: number, b: number) => void;
    readonly fdnreverb_set_q: (a: number, b: number) => void;
    readonly fdnreverb_set_rshape: (a: number, b: number) => void;
    readonly fdnreverb_set_swidth: (a: number, b: number) => void;
    readonly spatialenhancer_new: (a: number) => number;
    readonly spatialenhancer_process_block: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly spatialenhancer_set_ambience: (a: number, b: number) => void;
    readonly spatialenhancer_set_presence: (a: number, b: number) => void;
    readonly spatialenhancer_set_sshaper: (a: number, b: number, c: number) => void;
    readonly spatialenhancer_set_stereoizer: (a: number, b: number) => void;
    readonly __wbg_earlyreflections_free: (a: number, b: number) => void;
    readonly earlyreflections_new: (a: number) => number;
    readonly earlyreflections_process_block: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly earlyreflections_set_pattern: (a: number, b: number, c: number) => void;
    readonly earlyreflections_set_sdelay: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

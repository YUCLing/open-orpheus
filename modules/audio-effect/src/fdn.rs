use wasm_bindgen::prelude::*;

use crate::utils::{clamp, ms_to_samples, one_pole_coeff, pan_gains, sanitize_sample_rate};

const FDN_CHANNELS: usize = 8;
const MAX_DELAY_SECONDS: f32 = 2.0;

const HADAMARD_8: [[f32; FDN_CHANNELS]; FDN_CHANNELS] = [
    [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    [1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0],
    [1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0],
    [1.0, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0],
    [1.0, 1.0, 1.0, 1.0, -1.0, -1.0, -1.0, -1.0],
    [1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0],
    [1.0, 1.0, -1.0, -1.0, -1.0, -1.0, 1.0, 1.0],
    [1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0],
];

const FDN_BASE_DELAYS_MS: [f32; FDN_CHANNELS] = [37.1, 43.7, 53.3, 61.1, 71.9, 83.9, 97.3, 113.0];
const FDN_PANS: [f32; FDN_CHANNELS] = [-0.88, 0.82, -0.35, 0.48, -0.68, 0.28, 0.94, -0.12];

#[derive(Clone)]
struct Allpass {
    buffer: Vec<f32>,
    write: usize,
    coeff: f32,
}

impl Allpass {
    fn new(delay_samples: usize, coeff: f32) -> Self {
        Self {
            buffer: vec![0.0; delay_samples.max(1)],
            write: 0,
            coeff,
        }
    }

    fn set_coeff(&mut self, coeff: f32) {
        self.coeff = clamp(coeff, 0.0, 0.85);
    }

    fn process(&mut self, input: f32) -> f32 {
        let delayed = self.buffer[self.write];
        let output = delayed - self.coeff * input;
        self.buffer[self.write] = input + self.coeff * output;
        self.write += 1;
        if self.write >= self.buffer.len() {
            self.write = 0;
        }
        output
    }
}

#[wasm_bindgen]
pub struct FdnReverb {
    delay_lines: [Vec<f32>; FDN_CHANNELS],
    delay_lengths: [usize; FDN_CHANNELS],
    write_ptrs: [usize; FDN_CHANNELS],
    lpf_state: [f32; FDN_CHANNELS],
    lpf_coeff: f32,
    feedback_gains: [f32; FDN_CHANNELS],
    pre_delay: Vec<f32>,
    pre_delay_len: usize,
    pre_delay_ptr: usize,
    diffusers: [Allpass; 4],
    diffusion_mix: f32,
    output_width: f32,
    density: f32,
    quality: f32,
    decay: f32,
    rshape: f32,
    sample_rate: f32,
    max_delay_samples: usize,
}

#[wasm_bindgen]
impl FdnReverb {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = sanitize_sample_rate(sample_rate);
        let max_delay_samples = (sample_rate * MAX_DELAY_SECONDS).ceil() as usize + 1;
        let delay_lines = std::array::from_fn(|_| vec![0.0; max_delay_samples]);
        let mut rvb = Self {
            delay_lines,
            delay_lengths: [1; FDN_CHANNELS],
            write_ptrs: [0; FDN_CHANNELS],
            lpf_state: [0.0; FDN_CHANNELS],
            lpf_coeff: one_pole_coeff(8_000.0, sample_rate),
            feedback_gains: [0.72; FDN_CHANNELS],
            pre_delay: vec![0.0; max_delay_samples],
            pre_delay_len: ms_to_samples(25.0, sample_rate).min(max_delay_samples - 1),
            pre_delay_ptr: 0,
            diffusers: [
                Allpass::new(ms_to_samples(4.7, sample_rate), 0.55),
                Allpass::new(ms_to_samples(8.3, sample_rate), 0.55),
                Allpass::new(ms_to_samples(12.9, sample_rate), 0.55),
                Allpass::new(ms_to_samples(17.1, sample_rate), 0.55),
            ],
            diffusion_mix: 1.0,
            output_width: 1.8,
            density: 80.0,
            quality: 8.0,
            decay: 1.2,
            rshape: 100.0,
            sample_rate,
            max_delay_samples,
        };
        rvb.set_hf_damping(2.25);
        rvb.update_delay_lengths();
        rvb.update_feedback_gains();
        rvb
    }

    /// Process a block of stereo samples.
    ///
    /// `input_l` / `input_r`: input frames.
    /// `output_l` / `output_r`: wet output only, without dry signal.
    pub fn process_block(
        &mut self,
        input_l: &[f32],
        input_r: &[f32],
        output_l: &mut [f32],
        output_r: &mut [f32],
    ) {
        let n = input_l
            .len()
            .min(input_r.len())
            .min(output_l.len())
            .min(output_r.len());

        for i in 0..n {
            let (left, right) = self.process_frame(input_l[i], input_r[i]);
            output_l[i] = left;
            output_r[i] = right;
        }
    }

    pub fn set_decay(&mut self, dtime: f32) {
        self.decay = clamp(dtime, 0.15, 12.0);
        self.update_feedback_gains();
    }

    pub fn set_hf_damping(&mut self, damping: f32) {
        let norm = clamp((damping - 2.0) / 1.5, 0.0, 1.0);
        let cutoff = 12_000.0 * (1.0 - norm) + 1_700.0 * norm;
        self.lpf_coeff = one_pole_coeff(cutoff, self.sample_rate);
    }

    pub fn set_density(&mut self, density: f32) {
        self.density = clamp(density, 0.0, 100.0);
        self.update_delay_lengths();
        self.update_feedback_gains();
    }

    pub fn set_diffusion(&mut self, diffusion: f32) {
        let norm = clamp(diffusion / 100.0, 0.0, 1.0);
        self.diffusion_mix = norm;
        let coeff = 0.18 + norm * 0.55;
        for diffuser in &mut self.diffusers {
            diffuser.set_coeff(coeff);
        }
    }

    pub fn set_rshape(&mut self, rshape: f32) {
        self.rshape = clamp(rshape, 0.0, 120.0);
        self.update_delay_lengths();
        self.update_feedback_gains();
    }

    pub fn set_swidth(&mut self, swidth: f32) {
        self.output_width = clamp(swidth / 100.0, 0.35, 2.2);
    }

    pub fn set_pre_delay(&mut self, pdelay_ms: f32) {
        let len = ms_to_samples(pdelay_ms, self.sample_rate);
        self.pre_delay_len = len.min(self.max_delay_samples - 1);
        if self.pre_delay_ptr >= self.pre_delay_len.max(1) {
            self.pre_delay_ptr = 0;
        }
    }

    pub fn set_q(&mut self, q: f32) {
        self.quality = clamp(q, 6.0, 8.0);
        self.update_delay_lengths();
        self.update_feedback_gains();
    }
}

impl FdnReverb {
    fn process_frame(&mut self, left: f32, right: f32) -> (f32, f32) {
        let active_channels = self.active_channels();
        let mono = (left + right) * 0.5;
        let delayed_input = self.process_pre_delay(mono);
        let diffused_input = self.process_diffusion(delayed_input);

        let mut delayed = [0.0; FDN_CHANNELS];
        for (ch, out) in delayed.iter_mut().enumerate().take(active_channels) {
            let ptr = self.write_ptrs[ch];
            let raw = self.delay_lines[ch][ptr];
            let filtered = self.lpf_state[ch] + self.lpf_coeff * (raw - self.lpf_state[ch]);
            self.lpf_state[ch] = filtered;
            *out = filtered;
        }

        let matrix_scale = 1.0 / (active_channels as f32).sqrt();
        for (ch, row) in HADAMARD_8.iter().enumerate().take(active_channels) {
            let mut feedback = 0.0;
            for (coeff, delayed_sample) in row.iter().zip(delayed.iter()).take(active_channels) {
                feedback += *coeff * *delayed_sample;
            }
            let input_gain = if ch & 1 == 0 { 0.18 } else { -0.18 };
            let sample =
                diffused_input * input_gain + feedback * matrix_scale * self.feedback_gains[ch];
            let ptr = self.write_ptrs[ch];
            self.delay_lines[ch][ptr] = clamp(sample, -8.0, 8.0);
        }

        for ch in 0..active_channels {
            self.write_ptrs[ch] += 1;
            if self.write_ptrs[ch] >= self.delay_lengths[ch] {
                self.write_ptrs[ch] = 0;
            }
        }

        let mut out_l = 0.0;
        let mut out_r = 0.0;
        for ch in 0..active_channels {
            let pan = FDN_PANS[ch] * self.output_width;
            let (left_gain, right_gain) = pan_gains(pan);
            out_l += delayed[ch] * left_gain;
            out_r += delayed[ch] * right_gain;
        }

        let active_trim = (active_channels as f32 / FDN_CHANNELS as f32).sqrt();
        let trim = 0.27 * active_trim / (1.0 + (self.output_width - 1.0).max(0.0) * 0.2);
        (out_l * trim, out_r * trim)
    }

    fn process_pre_delay(&mut self, input: f32) -> f32 {
        if self.pre_delay_len == 0 {
            return input;
        }

        let output = self.pre_delay[self.pre_delay_ptr];
        self.pre_delay[self.pre_delay_ptr] = input;
        self.pre_delay_ptr += 1;
        if self.pre_delay_ptr >= self.pre_delay_len {
            self.pre_delay_ptr = 0;
        }
        output
    }

    fn process_diffusion(&mut self, input: f32) -> f32 {
        if self.diffusion_mix <= 0.001 {
            return input;
        }

        let mut wet = input;
        for diffuser in &mut self.diffusers {
            wet = diffuser.process(wet);
        }
        input * (1.0 - self.diffusion_mix) + wet * self.diffusion_mix
    }

    fn update_delay_lengths(&mut self) {
        let density_norm = self.density / 100.0;
        let quality_norm = (self.quality - 6.0) / 2.0;
        let density_scale = 1.18 - density_norm * 0.28 - quality_norm * 0.04;
        let room_scale = 0.72 + (self.rshape / 100.0) * 0.58;

        for (ch, base_ms) in FDN_BASE_DELAYS_MS.iter().enumerate() {
            let modulation = 1.0 + (ch as f32 - 3.5) * 0.012 * (self.rshape / 100.0);
            let len = ms_to_samples(
                base_ms * density_scale * room_scale * modulation,
                self.sample_rate,
            )
            .clamp(2, self.max_delay_samples - 1);
            self.delay_lengths[ch] = len;
            if self.write_ptrs[ch] >= len {
                self.write_ptrs[ch] = 0;
            }
        }
    }

    fn update_feedback_gains(&mut self) {
        for ch in 0..FDN_CHANNELS {
            let delay_seconds = self.delay_lengths[ch] as f32 / self.sample_rate;
            let gain = 10.0_f32.powf(-3.0 * delay_seconds / self.decay);
            self.feedback_gains[ch] = clamp(gain, 0.0, 0.997);
        }
    }

    fn active_channels(&self) -> usize {
        if self.quality < 6.5 {
            6
        } else if self.quality < 7.5 {
            7
        } else {
            FDN_CHANNELS
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    /// Run `frames` samples of the same stereo input through the reverb.
    fn run(reverb: &mut FdnReverb, frames: usize, left: f32, right: f32) -> (Vec<f32>, Vec<f32>) {
        let (mut out_l, mut out_r) = (vec![0.0; frames], vec![0.0; frames]);
        reverb.process_block(
            &vec![left; frames],
            &vec![right; frames],
            &mut out_l,
            &mut out_r,
        );
        (out_l, out_r)
    }

    #[test]
    fn defaults_stay_inside_their_bounds() {
        let reverb = FdnReverb::new(RATE);

        assert_eq!(reverb.sample_rate, RATE);
        assert_eq!(
            reverb.max_delay_samples,
            (RATE * MAX_DELAY_SECONDS).ceil() as usize + 1
        );
        assert_eq!(reverb.active_channels(), FDN_CHANNELS);
        assert!(reverb.lpf_coeff > 0.0 && reverb.lpf_coeff < 1.0);
        assert_eq!(
            reverb.pre_delay_len,
            ms_to_samples(25.0, RATE).min(reverb.max_delay_samples - 1)
        );

        for ch in 0..FDN_CHANNELS {
            let length = reverb.delay_lengths[ch];
            let feedback = reverb.feedback_gains[ch];

            assert!(
                length >= 2 && length < reverb.max_delay_samples,
                "channel {ch} delay length {length} out of range"
            );
            assert!(
                feedback > 0.0 && feedback <= 0.997,
                "channel {ch} feedback {feedback}"
            );
        }
    }

    #[test]
    fn silence_stays_silent() {
        let mut reverb = FdnReverb::new(RATE);

        let (out_l, out_r) = run(&mut reverb, 512, 0.0, 0.0);

        assert!(out_l.iter().all(|s| *s == 0.0));
        assert!(out_r.iter().all(|s| *s == 0.0));

        // Silence in and silence out is also what a `process_block` that never
        // enters its loop produces, so seed the delay lines and require the
        // silent frames to keep the tail flowing through them.
        let frames = 16_384;
        let mut impulse_l = vec![0.0; frames];
        let mut impulse_r = vec![0.0; frames];
        impulse_l[0] = 1.0;
        impulse_r[0] = 1.0;
        let (mut tail_l, mut tail_r) = (vec![0.0; frames], vec![0.0; frames]);

        reverb.process_block(&impulse_l, &impulse_r, &mut tail_l, &mut tail_r);

        let onset = tail_l
            .iter()
            .position(|s| *s != 0.0)
            .expect("a seeded reverb still has to produce its tail");
        assert!(
            onset > 0,
            "the wet signal is delayed instead of passed straight through"
        );
        assert!(tail_l.iter().chain(&tail_r).all(|s| s.is_finite()));
    }

    #[test]
    fn an_unsanitised_rate_is_corrected() {
        let reverb = FdnReverb::new(1_000.0);

        assert_eq!(reverb.sample_rate, 44_100.0);
    }

    #[test]
    fn the_tail_decays_after_an_impulse() {
        let mut reverb = FdnReverb::new(RATE);
        let frames = 48_000;
        let mut input_l = vec![0.0; frames];
        let mut input_r = vec![0.0; frames];
        input_l[0] = 1.0;
        input_r[0] = 1.0;
        let (mut out_l, mut out_r) = (vec![0.0; frames], vec![0.0; frames]);

        reverb.process_block(&input_l, &input_r, &mut out_l, &mut out_r);

        let onset = out_l
            .iter()
            .position(|s| *s != 0.0)
            .expect("the reverb never produced output");
        assert!(
            onset > 0,
            "pre-delay and diffusion should push the wet signal back"
        );

        let head: f32 = out_l[onset..onset + 4_096].iter().map(|s| s * s).sum();
        let tail: f32 = out_l[frames - 4_096..].iter().map(|s| s * s).sum();

        assert!(head > 0.0);
        assert!(
            tail < head,
            "tail {tail} should be quieter than head {head}"
        );
        assert!(out_l.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn hot_input_stays_bounded_and_clamped() {
        let mut reverb = FdnReverb::new(RATE);

        let (out_l, out_r) = run(&mut reverb, 4_096, 1.0, -1.0);

        assert!(out_l.iter().chain(&out_r).all(|s| s.is_finite()));
        assert!(out_l.iter().all(|s| s.abs() < 10.0));
        for ch in 0..FDN_CHANNELS {
            assert!(
                reverb.delay_lines[ch].iter().all(|s| s.abs() <= 8.0),
                "channel {ch} delay line escaped the clamp"
            );
        }
    }

    #[test]
    fn decay_is_clamped_and_drives_the_feedback() {
        let mut reverb = FdnReverb::new(RATE);

        reverb.set_decay(0.01);
        assert_eq!(reverb.decay, 0.15);
        let short: Vec<f32> = reverb.feedback_gains.to_vec();

        reverb.set_decay(100.0);
        assert_eq!(reverb.decay, 12.0);
        let long: Vec<f32> = reverb.feedback_gains.to_vec();

        for ch in 0..FDN_CHANNELS {
            let (long_gain, short_gain) = (long[ch], short[ch]);

            assert!(
                long_gain > short_gain,
                "channel {ch}: {long_gain} should exceed {short_gain}"
            );
        }
    }

    #[test]
    fn quality_selects_how_many_channels_run() {
        let mut reverb = FdnReverb::new(RATE);

        reverb.set_q(6.0);
        assert_eq!(reverb.quality, 6.0);
        assert_eq!(reverb.active_channels(), 6);

        reverb.set_q(7.0);
        assert_eq!(reverb.active_channels(), 7);

        reverb.set_q(8.0);
        assert_eq!(reverb.active_channels(), FDN_CHANNELS);

        // Out of range values saturate.
        reverb.set_q(2.0);
        assert_eq!(reverb.quality, 6.0);
        reverb.set_q(99.0);
        assert_eq!(reverb.quality, 8.0);
    }

    #[test]
    fn a_reduced_channel_count_is_still_finite() {
        let mut reverb = FdnReverb::new(RATE);
        reverb.set_q(6.0);

        let (out_l, out_r) = run(&mut reverb, 2_048, 1.0, 1.0);

        assert!(out_l.iter().chain(&out_r).all(|s| s.is_finite()));
    }

    #[test]
    fn density_and_room_shape_change_the_delay_lengths() {
        let mut reverb = FdnReverb::new(RATE);
        let default: Vec<usize> = reverb.delay_lengths.to_vec();

        reverb.set_density(0.0);
        assert_eq!(reverb.density, 0.0);
        let sparse: Vec<usize> = reverb.delay_lengths.to_vec();
        assert!(sparse[0] > default[0], "less density means longer lines");

        reverb.set_density(100.0);
        assert_eq!(reverb.density, 100.0);
        assert!(reverb.delay_lengths[0] < sparse[0]);

        reverb.set_rshape(0.0);
        assert_eq!(reverb.rshape, 0.0);
        let small: Vec<usize> = reverb.delay_lengths.to_vec();
        reverb.set_rshape(120.0);
        assert_eq!(reverb.rshape, 120.0);
        assert!(
            reverb.delay_lengths[0] > small[0],
            "a bigger room means longer lines"
        );

        // Out of range values saturate.
        reverb.set_rshape(1_000.0);
        assert_eq!(reverb.rshape, 120.0);
        reverb.set_density(-5.0);
        assert_eq!(reverb.density, 0.0);
    }

    #[test]
    fn shrinking_a_delay_line_rewinds_its_write_pointer() {
        let mut reverb = FdnReverb::new(RATE);
        // Long enough that the write pointers land past the shortened lengths:
        // without that the assertions below hold whether or not the rewind runs.
        run(&mut reverb, 6_000, 1.0, 0.0);
        let before = reverb.write_ptrs;

        reverb.set_density(100.0);
        reverb.set_rshape(0.0);

        for (ch, previous) in before.iter().enumerate() {
            let length = reverb.delay_lengths[ch];
            let pointer = reverb.write_ptrs[ch];

            assert!(
                pointer < length,
                "channel {ch} write pointer {pointer} vs length {length}"
            );
            if *previous >= length {
                assert_eq!(
                    pointer, 0,
                    "channel {ch} was {pointer} past a {length} sample line"
                );
            }
        }

        assert!(
            (0..FDN_CHANNELS).any(|ch| before[ch] >= reverb.delay_lengths[ch]),
            "the shrink has to cross at least one pointer or this proves nothing"
        );
    }

    #[test]
    fn pre_delay_can_be_bypassed_and_is_bounded() {
        let mut reverb = FdnReverb::new(RATE);

        reverb.set_pre_delay(0.0);
        assert_eq!(reverb.pre_delay_len, 0);
        assert_eq!(reverb.process_pre_delay(0.75), 0.75, "bypassed");

        // The line is exactly `pre_delay_len` samples deep.
        reverb.set_pre_delay(25.0);
        assert_eq!(reverb.pre_delay_len, ms_to_samples(25.0, RATE));
        for _ in 0..reverb.pre_delay_len {
            assert_eq!(reverb.process_pre_delay(0.5), 0.0);
        }
        assert_eq!(
            reverb.process_pre_delay(0.5),
            0.5,
            "replayed after the delay"
        );

        reverb.set_pre_delay(10_000.0);
        assert_eq!(reverb.pre_delay_len, reverb.max_delay_samples - 1);
        assert!(reverb.pre_delay_ptr < reverb.pre_delay_len.max(1));

        // Shortening the line below the current write position rewinds the
        // pointer, so the tail cannot outlive the shorter line it now addresses.
        reverb.set_pre_delay(100.0);
        for _ in 0..reverb.pre_delay_len / 2 {
            reverb.process_pre_delay(0.5);
        }
        assert!(reverb.pre_delay_ptr > 0, "the pointer has to advance first");

        reverb.set_pre_delay(0.0);
        assert_eq!(
            reverb.pre_delay_ptr, 0,
            "a shorter line rewinds the pointer"
        );
    }

    #[test]
    fn stereo_width_and_damping_are_clamped() {
        let mut reverb = FdnReverb::new(RATE);

        reverb.set_swidth(200.0);
        assert_eq!(reverb.output_width, 2.0);
        reverb.set_swidth(0.0);
        assert_eq!(reverb.output_width, 0.35);

        reverb.set_hf_damping(2.0);
        let bright = reverb.lpf_coeff;
        reverb.set_hf_damping(3.5);
        let dark = reverb.lpf_coeff;
        assert!(
            bright > dark && dark > 0.0,
            "damping should lower the cutoff ({bright} vs {dark})"
        );
    }

    #[test]
    fn diffusion_controls_the_allpass_coefficients() {
        let mut reverb = FdnReverb::new(RATE);

        reverb.set_diffusion(0.0);
        assert_eq!(reverb.diffusion_mix, 0.0);
        assert!((reverb.diffusers[0].coeff - 0.18).abs() < 1e-6);
        assert_eq!(reverb.process_diffusion(0.5), 0.5, "bypassed");

        reverb.set_diffusion(100.0);
        assert_eq!(reverb.diffusion_mix, 1.0);
        assert!((reverb.diffusers[0].coeff - 0.73).abs() < 1e-6);

        reverb.set_diffusion(1_000.0);
        assert_eq!(reverb.diffusion_mix, 1.0);
    }

    #[test]
    fn mismatched_block_lengths_only_write_the_common_part() {
        let mut reverb = FdnReverb::new(RATE);
        let (mut out_l, mut out_r) = (vec![0.0; 3], vec![0.0]);

        reverb.process_block(&[1.0, 1.0, 1.0], &[1.0, 1.0, 1.0], &mut out_l, &mut out_r);

        assert_eq!(&out_l[1..], &[0.0, 0.0], "untouched tail");
    }

    #[test]
    fn an_allpass_preserves_energy() {
        let mut allpass = Allpass::new(16, 0.55);
        let impulse = [1.0_f32];
        let energy: f32 = std::iter::repeat_n(impulse, 1)
            .flatten()
            .chain(std::iter::repeat_n(0.0_f32, 4_095))
            .map(|sample| allpass.process(sample).powi(2))
            .sum();

        assert!((energy - 1.0).abs() < 1e-4, "energy {energy}");
    }

    #[test]
    fn allpass_parameters_are_clamped() {
        let mut allpass = Allpass::new(0, 0.5);

        assert_eq!(allpass.buffer.len(), 1, "at least one sample of delay");

        allpass.set_coeff(-1.0);
        assert_eq!(allpass.coeff, 0.0);
        allpass.set_coeff(5.0);
        assert_eq!(allpass.coeff, 0.85);
    }
}

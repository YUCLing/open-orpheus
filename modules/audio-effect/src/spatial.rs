use wasm_bindgen::prelude::*;

use crate::utils::{clamp, ms_to_samples, sanitize_sample_rate};

#[wasm_bindgen]
pub struct SpatialEnhancer {
    sample_rate: f32,
    presence_norm: f32,
    stereoizer_norm: f32,
    width_gain: f32,
    mid_gain: f32,
    ambience_gain: f32,
    sshaper: bool,
    haas_delay: Vec<f32>,
    haas_write: usize,
    haas_delay_samples: usize,
    haas_gain: f32,
}

#[wasm_bindgen]
impl SpatialEnhancer {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = sanitize_sample_rate(sample_rate);
        let max_haas = ms_to_samples(24.0, sample_rate).max(1);
        Self {
            sample_rate,
            presence_norm: 0.0,
            stereoizer_norm: 0.0,
            width_gain: 1.0,
            mid_gain: 1.0,
            ambience_gain: 1.0,
            sshaper: false,
            haas_delay: vec![0.0; max_haas],
            haas_write: 0,
            haas_delay_samples: ms_to_samples(12.0, sample_rate).clamp(1, max_haas),
            haas_gain: 0.22,
        }
    }

    /// Process a block of stereo samples in place.
    pub fn process_block(&mut self, input_l: &mut [f32], input_r: &mut [f32]) {
        let n = input_l.len().min(input_r.len());
        for i in 0..n {
            let left = input_l[i];
            let right = input_r[i];
            let mut mid = (left + right) * 0.5 * self.mid_gain;
            let mut side = (left - right) * 0.5 * self.width_gain * self.ambience_gain;

            if self.sshaper {
                let read = (self.haas_write + self.haas_delay.len() - self.haas_delay_samples)
                    % self.haas_delay.len();
                let delayed_side = self.haas_delay[read];
                self.haas_delay[self.haas_write] = side;
                self.haas_write += 1;
                if self.haas_write >= self.haas_delay.len() {
                    self.haas_write = 0;
                }

                side += delayed_side * self.haas_gain;
                mid *= 0.98;
            }

            let trim = 1.0 / (1.0 + (self.width_gain - 1.0).max(0.0) * 0.18);
            input_l[i] = (mid + side) * trim;
            input_r[i] = (mid - side) * trim;
        }
    }

    /// Set presence (surround depth, 0-10). Controls mid/side balance.
    pub fn set_presence(&mut self, presence: f32) {
        self.presence_norm = clamp(presence / 10.0, 0.0, 1.0);
        self.update_width();
    }

    /// Set stereoizer (width expansion, 0-10). Controls side gain boost.
    pub fn set_stereoizer(&mut self, stereoizer: f32) {
        self.stereoizer_norm = clamp(stereoizer / 10.0, 0.0, 1.0);
        self.update_width();
    }

    /// Enable/disable stereo shaping (Haas delay).
    pub fn set_sshaper(&mut self, on: bool, sample_rate: f32) {
        let sample_rate = sanitize_sample_rate(sample_rate);
        if (sample_rate - self.sample_rate).abs() > f32::EPSILON {
            self.sample_rate = sample_rate;
            let max_haas = ms_to_samples(24.0, sample_rate).max(1);
            self.haas_delay = vec![0.0; max_haas];
            self.haas_delay_samples = ms_to_samples(12.0, sample_rate).clamp(1, max_haas);
            self.haas_write = 0;
        }
        self.sshaper = on;
    }

    /// Set ambience coefficient.
    pub fn set_ambience(&mut self, ambience: f32) {
        self.ambience_gain = 1.0 + (clamp(ambience, 0.0, 4.0) - 1.0) * 0.06;
    }
}

impl SpatialEnhancer {
    fn update_width(&mut self) {
        self.mid_gain = 1.0 - self.presence_norm * 0.08;
        self.width_gain = 1.0 + self.stereoizer_norm * 0.85 + self.presence_norm * 0.22;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    #[test]
    fn defaults_are_transparent() {
        let enhancer = SpatialEnhancer::new(RATE);

        assert_eq!(enhancer.sample_rate, RATE);
        assert_eq!(enhancer.mid_gain, 1.0);
        assert_eq!(enhancer.width_gain, 1.0);
        assert_eq!(enhancer.ambience_gain, 1.0);
        assert!(!enhancer.sshaper);
    }

    #[test]
    fn an_unsanitised_rate_is_corrected() {
        assert_eq!(SpatialEnhancer::new(0.0).sample_rate, 44_100.0);
        assert_eq!(SpatialEnhancer::new(f32::NAN).sample_rate, 44_100.0);
    }

    #[test]
    fn presence_and_stereoizer_shape_the_mid_side_balance() {
        let mut enhancer = SpatialEnhancer::new(RATE);

        enhancer.set_presence(10.0);
        assert_eq!(enhancer.presence_norm, 1.0);
        assert!((enhancer.mid_gain - 0.92).abs() < 1e-6);
        assert!((enhancer.width_gain - 1.22).abs() < 1e-6);

        enhancer.set_stereoizer(10.0);
        assert_eq!(enhancer.stereoizer_norm, 1.0);
        assert!((enhancer.width_gain - 2.07).abs() < 1e-6);
    }

    #[test]
    fn presence_and_stereoizer_are_clamped() {
        let mut enhancer = SpatialEnhancer::new(RATE);

        enhancer.set_presence(500.0);
        enhancer.set_stereoizer(500.0);
        assert_eq!(enhancer.presence_norm, 1.0);
        assert_eq!(enhancer.stereoizer_norm, 1.0);

        enhancer.set_presence(-500.0);
        enhancer.set_stereoizer(-500.0);
        assert_eq!(enhancer.presence_norm, 0.0);
        assert_eq!(enhancer.stereoizer_norm, 0.0);
        assert_eq!(enhancer.width_gain, 1.0, "back to neutral");
    }

    #[test]
    fn ambience_maps_around_unity() {
        let mut enhancer = SpatialEnhancer::new(RATE);

        enhancer.set_ambience(1.0);
        assert_eq!(enhancer.ambience_gain, 1.0);

        enhancer.set_ambience(0.0);
        assert!((enhancer.ambience_gain - 0.94).abs() < 1e-6);

        enhancer.set_ambience(4.0);
        assert!((enhancer.ambience_gain - 1.18).abs() < 1e-6);

        enhancer.set_ambience(100.0);
        assert!((enhancer.ambience_gain - 1.18).abs() < 1e-6, "clamped to 4");
    }

    #[test]
    fn a_neutral_enhancer_passes_the_block_through_unchanged() {
        let mut enhancer = SpatialEnhancer::new(RATE);
        let (mut left, mut right) = (vec![0.5, -0.25, 0.0], vec![-0.5, 0.25, 0.0]);

        enhancer.process_block(&mut left, &mut right);

        assert_eq!(left, vec![0.5, -0.25, 0.0]);
        assert_eq!(right, vec![-0.5, 0.25, 0.0]);
    }

    #[test]
    fn widening_boosts_the_side_signal_only() {
        let mut enhancer = SpatialEnhancer::new(RATE);
        enhancer.set_stereoizer(10.0);
        // Opening the width also pulls the overall level down to make room.
        let trim = 1.0 / (1.0 + (enhancer.width_gain - 1.0) * 0.18);

        // Mid-only content stays balanced; it is only attenuated by the trim.
        let (mut mid_l, mut mid_r) = (vec![0.5], vec![0.5]);
        enhancer.process_block(&mut mid_l, &mut mid_r);
        assert_eq!(mid_l[0], mid_r[0], "no side signal is invented");
        assert!((mid_l[0] - 0.5 * trim).abs() < 1e-6);

        // Anti-phase content is pure side, so it gets louder.
        let (mut side_l, mut side_r) = (vec![0.5], vec![-0.5]);
        enhancer.process_block(&mut side_l, &mut side_r);
        assert!(side_l[0] > 0.5);
        assert!(side_r[0] < -0.5);
        assert_eq!(side_l[0], -side_r[0], "side stays anti-phase");
    }

    #[test]
    fn mismatched_block_lengths_only_process_the_common_part() {
        let mut enhancer = SpatialEnhancer::new(RATE);
        // A neutral enhancer is transparent, so it cannot show whether the
        // shared samples were processed at all. Widening makes the shared
        // sample come out changed, which a no-op `process_block` cannot fake.
        enhancer.set_stereoizer(10.0);
        let trim = 1.0 / (1.0 + (enhancer.width_gain - 1.0) * 0.18);
        let (mut left, mut right) = (vec![0.5, 1.0, 1.0], vec![-0.5]);

        enhancer.process_block(&mut left, &mut right);

        // Anti-phase content is pure side, so exactly one sample is shared and
        // it must come out widened; `right` has no index 1 to process.
        let widened = 0.5 * enhancer.width_gain * trim;
        let (left_out, right_out) = (left[0], right[0]);
        let expected_right = -widened;

        assert!(
            (left_out - widened).abs() < 1e-6,
            "left[0] = {left_out}, expected {widened}"
        );
        assert!(
            (right_out - expected_right).abs() < 1e-6,
            "right[0] = {right_out}, expected {expected_right}"
        );
        assert_eq!(&left[1..], &[1.0, 1.0], "untouched tail");
    }

    #[test]
    fn stereo_shaping_delays_the_side_signal() {
        let mut enhancer = SpatialEnhancer::new(RATE);
        enhancer.set_sshaper(true, RATE);

        assert!(enhancer.sshaper);
        assert!(enhancer.haas_delay_samples >= 1);
        assert!(enhancer.haas_delay_samples < enhancer.haas_delay.len());

        // An anti-phase impulse leaves a delayed echo on the side channel.
        let mut left = vec![0.0; 2_000];
        let mut right = vec![0.0; 2_000];
        left[0] = 1.0;
        right[0] = -1.0;
        enhancer.process_block(&mut left, &mut right);

        let echo = enhancer.haas_delay_samples;
        assert_ne!(left[echo], 0.0, "delayed side contribution expected");
        assert!(left[echo] > 0.0);
        assert!(right[echo] < 0.0);
    }

    #[test]
    fn changing_the_sample_rate_rebuilds_the_delay_line() {
        let mut enhancer = SpatialEnhancer::new(RATE);
        enhancer.set_sshaper(true, 8_000.0);

        assert_eq!(enhancer.sample_rate, 8_000.0);
        assert_eq!(enhancer.haas_delay.len(), ms_to_samples(24.0, 8_000.0));
    }

    #[test]
    fn an_extreme_configuration_stays_finite() {
        let mut enhancer = SpatialEnhancer::new(RATE);
        enhancer.set_presence(10.0);
        enhancer.set_stereoizer(10.0);
        enhancer.set_ambience(4.0);
        enhancer.set_sshaper(true, RATE);

        let mut left = vec![0.9; 512];
        let mut right = vec![-0.9; 512];
        enhancer.process_block(&mut left, &mut right);

        assert!(left.iter().all(|s| s.is_finite()));
        assert!(right.iter().all(|s| s.is_finite()));
    }
}

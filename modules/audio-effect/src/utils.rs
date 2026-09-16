const PI2: f32 = std::f32::consts::PI * 2.0;

pub(crate) fn sanitize_sample_rate(sample_rate: f32) -> f32 {
    if sample_rate.is_finite() && sample_rate >= 8_000.0 {
        sample_rate
    } else {
        44_100.0
    }
}

pub(crate) fn clamp(value: f32, min: f32, max: f32) -> f32 {
    value.max(min).min(max)
}

pub(crate) fn ms_to_samples(ms: f32, sample_rate: f32) -> usize {
    ((ms.max(0.0) * sample_rate) / 1000.0).round() as usize
}

pub(crate) fn one_pole_coeff(cutoff_hz: f32, sample_rate: f32) -> f32 {
    let cutoff = clamp(cutoff_hz, 20.0, sample_rate * 0.45);
    1.0 - (-PI2 * cutoff / sample_rate).exp()
}

pub(crate) fn pan_gains(pan: f32) -> (f32, f32) {
    let pan = clamp(pan, -1.0, 1.0);
    (((1.0 - pan) * 0.5).sqrt(), ((1.0 + pan) * 0.5).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_sample_rate_accepts_sane_rates() {
        assert_eq!(sanitize_sample_rate(44_100.0), 44_100.0);
        assert_eq!(sanitize_sample_rate(8_000.0), 8_000.0);
        assert_eq!(sanitize_sample_rate(192_000.0), 192_000.0);
    }

    #[test]
    fn sanitize_sample_rate_falls_back_for_bad_rates() {
        for bad in [
            0.0,
            -1.0,
            7_999.0,
            f32::NAN,
            f32::INFINITY,
            f32::NEG_INFINITY,
        ] {
            assert_eq!(sanitize_sample_rate(bad), 44_100.0, "for {bad}");
        }
    }

    #[test]
    fn clamp_keeps_values_inside_the_range() {
        assert_eq!(clamp(5.0, 0.0, 10.0), 5.0);
        assert_eq!(clamp(-1.0, 0.0, 10.0), 0.0);
        assert_eq!(clamp(11.0, 0.0, 10.0), 10.0);
        assert_eq!(clamp(f32::NAN, 0.0, 10.0), 0.0, "NaN loses to max()");
    }

    #[test]
    fn ms_to_samples_converts_and_rounds() {
        assert_eq!(ms_to_samples(1_000.0, 44_100.0), 44_100);
        assert_eq!(ms_to_samples(0.0, 44_100.0), 0);
        // Rounds to nearest instead of truncating.
        assert_eq!(ms_to_samples(0.01, 1_000.0), 0);
        assert_eq!(ms_to_samples(0.6, 1_000.0), 1);
        assert_eq!(ms_to_samples(25.0, 8_000.0), 200);
    }

    #[test]
    fn ms_to_samples_never_underflows_on_negative_input() {
        assert_eq!(ms_to_samples(-500.0, 44_100.0), 0);
    }

    #[test]
    fn one_pole_coeff_stays_inside_the_unit_interval() {
        for cutoff in [1.0, 20.0, 1_000.0, 22_050.0, 100_000.0] {
            let coeff = one_pole_coeff(cutoff, 44_100.0);
            assert!(
                coeff > 0.0 && coeff < 1.0,
                "cutoff {cutoff} produced {coeff}"
            );
        }
    }

    #[test]
    fn one_pole_coeff_grows_with_cutoff() {
        let low = one_pole_coeff(200.0, 44_100.0);
        let mid = one_pole_coeff(2_000.0, 44_100.0);
        let high = one_pole_coeff(12_000.0, 44_100.0);

        assert!(low < mid && mid < high, "{low} {mid} {high}");
    }

    #[test]
    fn one_pole_coeff_is_clamped_against_nyquist() {
        // Above 0.45 * sample rate both cutoffs clamp to the same value.
        assert_eq!(
            one_pole_coeff(30_000.0, 44_100.0),
            one_pole_coeff(19_845.0, 44_100.0)
        );
    }

    #[test]
    fn pan_gains_keep_constant_power() {
        for pan in [-1.0, -0.5, 0.0, 0.25, 0.5, 1.0] {
            let (left, right) = pan_gains(pan);
            let power = left * left + right * right;
            assert!((power - 1.0).abs() < 1e-5, "pan {pan} gave {power}");
        }
    }

    #[test]
    fn pan_gains_are_symmetric_and_clamped() {
        assert_eq!(
            pan_gains(0.0),
            (
                std::f32::consts::FRAC_1_SQRT_2,
                std::f32::consts::FRAC_1_SQRT_2
            )
        );
        assert_eq!(pan_gains(-1.0), (1.0, 0.0));
        assert_eq!(pan_gains(1.0), (0.0, 1.0));
        // Out-of-range pans saturate instead of producing NaN.
        assert_eq!(pan_gains(-9.0), (1.0, 0.0));
        assert_eq!(pan_gains(9.0), (0.0, 1.0));
    }
}

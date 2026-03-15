use rand::{RngExt, distr::Alphanumeric};

pub fn random_string(length: usize) -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

/// Performs a dry-run egui layout pass and returns the size of the content
/// drawn by `run_ui`.
///
/// `ctx` should be pre-configured (fonts, visuals, etc.) before being passed
/// in — use [`App::create_context`] for a fully set-up context.
/// `available_width` sets the horizontal space offered to the layout.
pub fn measure_ui(
    ctx: egui::Context,
    available_width: f32,
    run_ui: impl FnOnce(&mut egui::Ui),
) -> egui::Vec2 {
    let mut measured = egui::Vec2::ZERO;
    let mut run_ui = Some(run_ui);
    let _ = ctx.run(
        egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::Vec2::new(available_width, 100_000.0),
            )),
            ..Default::default()
        },
        |ctx| {
            egui::CentralPanel::default()
                .frame(egui::Frame::new())
                .show(ctx, |ui| {
                    if let Some(f) = run_ui.take() {
                        let resp = ui.vertical(f);
                        measured = resp.response.rect.size();
                    }
                });
        },
    );
    measured
}

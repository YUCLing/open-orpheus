use egui::{FontData, FontDefinitions, FontFamily};
use font_kit::source::SystemSource;

const DEFAULT_FONTS: &[&str] = &[
    "Noto Sans CJK SC",
    "Microsoft YaHei",
    "PingFang SC",
    "Source Han Sans SC",
    "WenQuanYi Micro Hei",
];

pub fn get_font_definitions() -> FontDefinitions {
    let mut fonts = FontDefinitions::default();

    let system_source = SystemSource::new();

    'search_font: for &font_name in DEFAULT_FONTS {
        if let Ok(handles) = system_source.select_family_by_name(font_name) {
            for handle in handles.fonts() {
                if let Ok(font) = handle.load() {
                    let font_data = font.copy_font_data().unwrap();
                    fonts.font_data.insert(
                        font_name.to_string(),
                        std::sync::Arc::new(FontData::from_owned(font_data.to_vec())),
                    );
                    fonts
                        .families
                        .get_mut(&FontFamily::Proportional)
                        .unwrap()
                        .insert(0, font_name.to_string());
                    break 'search_font;
                }
            }
        }
    }

    fonts
}

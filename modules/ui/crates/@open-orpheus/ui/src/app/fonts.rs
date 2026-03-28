use egui::epaint::text::{FontInsert, FontPriority, InsertFontFamily};
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

/// Loads a custom font by family name from the system and registers it with
/// the egui context under `FontFamily::Name(family_name)`.
///
/// Uses `ctx.add_font` to avoid overriding previously registered fonts.
/// Returns `true` if the font was successfully loaded, `false` if not found.
pub fn load_custom_font(ctx: &egui::Context, family_name: &str) -> bool {
    let system_source = SystemSource::new();
    let Ok(handles) = system_source.select_family_by_name(family_name) else {
        return false;
    };

    for handle in handles.fonts() {
        if let Ok(font) = handle.load()
            && let Some(font_data) = font.copy_font_data()
        {
            ctx.add_font(FontInsert::new(
                family_name,
                FontData::from_owned(font_data.to_vec()),
                vec![
                    InsertFontFamily {
                        family: FontFamily::Name(family_name.into()),
                        priority: FontPriority::Highest,
                    },
                    InsertFontFamily {
                        family: FontFamily::Proportional,
                        priority: FontPriority::Lowest,
                    },
                ],
            ));
            return true;
        }
    }

    false
}

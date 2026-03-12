use std::sync::Arc;

use base64::{Engine, prelude::BASE64_STANDARD};
use egui::load::{ImageLoadResult, ImageLoader, ImagePoll, LoadError};

pub(super) struct Base64Loader {}

impl ImageLoader for Base64Loader {
    fn id(&self) -> &str {
        concat!(module_path!(), "::Base64Loader")
    }

    fn load(
        &self,
        _ctx: &egui::Context,
        uri: &str,
        size_hint: egui::SizeHint,
    ) -> egui::load::ImageLoadResult {
        if !uri.starts_with("base64://") {
            return ImageLoadResult::Err(LoadError::NotSupported);
        }
        let base64_data = &uri["base64://".len() + 3..];
        let kind = &uri["base64://".len()..("base64://".len() + 3)];
        match BASE64_STANDARD.decode(base64_data) {
            Ok(data) => {
                if kind == "svg" {
                    egui_extras::image::load_svg_bytes_with_size(
                        &data,
                        size_hint,
                        &resvg::usvg::Options::default(),
                    )
                    .map(|img| {
                        ImageLoadResult::Ok(ImagePoll::Ready {
                            image: Arc::new(img),
                        })
                    })
                    .unwrap_or_else(|_| ImageLoadResult::Err(LoadError::NotSupported))
                } else {
                    egui_extras::image::load_image_bytes(&data).map(|img| ImagePoll::Ready {
                        image: Arc::new(img),
                    })
                }
            }
            Err(_) => ImageLoadResult::Err(LoadError::NotSupported),
        }
    }

    fn forget(&self, _uri: &str) {
    }

    fn forget_all(&self) {
    }

    fn byte_size(&self) -> usize {
        0
    }
}

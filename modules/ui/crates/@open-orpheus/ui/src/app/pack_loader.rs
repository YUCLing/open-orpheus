use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use egui::load::{ImageLoadResult, ImageLoader, ImagePoll, LoadError};

use crate::resource::ResourceHandler;

enum LoadState {
    Loading,
    Ready(Arc<egui::ColorImage>),
    Failed,
}

type ReadFn = Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Vec<u8>> + Send>> + Send + Sync>;

/// A generic pack-file image loader.
///
/// Each instance handles URIs that begin with a specific scheme and delegates
/// byte-reading to the supplied async function.
pub(super) struct PackLoader {
    scheme: &'static str,
    read_fn: ReadFn,
    cache: Arc<Mutex<HashMap<String, LoadState>>>,
}

impl PackLoader {
    fn new(scheme: &'static str, read_fn: ReadFn) -> Self {
        Self {
            scheme,
            read_fn,
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Handles `orpheus://orpheus/<path>` via [`ResourceHandler::read_web_pack`].
    pub(super) fn for_web_pack(resource_handler: ResourceHandler) -> Self {
        Self::new(
            "orpheus://orpheus",
            Arc::new(move |path: String| {
                let h = resource_handler.clone();
                Box::pin(async move { h.read_web_pack(&path).await })
            }),
        )
    }

    /// Handles `native://skin/<path>` via [`ResourceHandler::read_skin_pack`].
    pub(super) fn for_skin_pack(resource_handler: ResourceHandler) -> Self {
        Self::new(
            "native://skin",
            Arc::new(move |path: String| {
                let h = resource_handler.clone();
                Box::pin(async move { h.read_skin_pack(&path).await })
            }),
        )
    }
}

impl ImageLoader for PackLoader {
    fn id(&self) -> &str {
        self.scheme
    }

    fn load(&self, ctx: &egui::Context, uri: &str, size_hint: egui::SizeHint) -> ImageLoadResult {
        if !uri.starts_with(self.scheme) {
            return ImageLoadResult::Err(LoadError::NotSupported);
        }

        let path = uri[self.scheme.len()..].to_owned();

        {
            let cache = self.cache.lock().unwrap();
            match cache.get(uri) {
                Some(LoadState::Ready(img)) => {
                    return ImageLoadResult::Ok(ImagePoll::Ready { image: img.clone() });
                }
                Some(LoadState::Loading) => {
                    return ImageLoadResult::Ok(ImagePoll::Pending { size: None });
                }
                Some(LoadState::Failed) => {
                    return ImageLoadResult::Err(LoadError::Loading(format!(
                        "failed to load pack resource: {uri}"
                    )));
                }
                None => {}
            }
        }

        // First time seeing this URI — kick off the async load.
        self.cache
            .lock()
            .unwrap()
            .insert(uri.to_owned(), LoadState::Loading);

        let uri_owned = uri.to_owned();
        let read_fn = self.read_fn.clone();
        let cache = self.cache.clone();
        let ctx = ctx.clone();

        smol::spawn(async move {
            let bytes = read_fn(path.clone()).await;

            let result: Option<Arc<egui::ColorImage>> = if path.ends_with(".svg") {
                egui_extras::image::load_svg_bytes_with_size(
                    &bytes,
                    size_hint,
                    &resvg::usvg::Options::default(),
                )
                .map(Arc::new)
                .ok()
            } else {
                egui_extras::image::load_image_bytes(&bytes)
                    .map(Arc::new)
                    .ok()
            };

            let new_state = match result {
                Some(img) => LoadState::Ready(img),
                None => LoadState::Failed,
            };
            cache.lock().unwrap().insert(uri_owned, new_state);
            ctx.request_repaint();
        })
        .detach();

        ImageLoadResult::Ok(ImagePoll::Pending { size: None })
    }

    fn forget(&self, uri: &str) {
        self.cache.lock().unwrap().remove(uri);
    }

    fn forget_all(&self) {
        self.cache.lock().unwrap().clear();
    }

    fn byte_size(&self) -> usize {
        self.cache
            .lock()
            .unwrap()
            .values()
            .map(|state| match state {
                LoadState::Ready(img) => img.pixels.len() * 4,
                _ => 0,
            })
            .sum()
    }
}

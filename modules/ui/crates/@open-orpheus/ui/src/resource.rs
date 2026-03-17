use std::{pin::Pin, sync::Arc};

#[derive(Clone)]
pub struct ResourceHandler {
    read_web_pack:
        Arc<Box<dyn Fn(&str) -> Pin<Box<dyn Future<Output = Vec<u8>> + Send>> + Send + Sync>>,
    read_skin_pack:
        Arc<Box<dyn Fn(&str) -> Pin<Box<dyn Future<Output = Vec<u8>> + Send>> + Send + Sync>>,
}

impl ResourceHandler {
    pub fn new(
        read_web_pack: impl Fn(&str) -> Pin<Box<dyn Future<Output = Vec<u8>> + Send>>
        + Send
        + Sync
        + 'static,
        read_skin_pack: impl Fn(&str) -> Pin<Box<dyn Future<Output = Vec<u8>> + Send>>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self {
            read_web_pack: Arc::new(Box::new(read_web_pack)),
            read_skin_pack: Arc::new(Box::new(read_skin_pack)),
        }
    }

    pub async fn read_web_pack(&self, url: &str) -> Vec<u8> {
        let handler = self.read_web_pack.clone();
        handler(url).await
    }

    pub async fn read_skin_pack(&self, path: &str) -> Vec<u8> {
        let handler = self.read_skin_pack.clone();
        handler(path).await
    }
}

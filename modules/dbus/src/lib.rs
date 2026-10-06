#![deny(clippy::all)]

use napi::bindgen_prelude::{Either, Promise, Undefined};

/// Run an async body as a JS promise.
///
/// The body is spawned on the shared smol executor and must resolve to a
/// `std::result::Result<_, _>` whose error is stringifiable. The caller
/// returns the deferred object, which JS observes as a promise of the value.
///
/// Defined here, above the module declarations, so every child module can use
/// it through `macro_rules!`'s textual scope.
macro_rules! napi_deferred_task {
    ($env:ident, $body:expr) => {{
        let (deferred, object) = $env.create_deferred()?;
        smol::spawn(async move {
            match $body.await {
                Ok(val) => deferred.resolve(move |_env| Ok(val)),
                Err(err) => deferred.reject(napi::Error::from_reason(err.to_string())),
            }
        })
        .detach();
        Ok(object)
    }};
}

/// What a JS event handler may return.
///
/// A handler may be synchronous (it returns nothing) or asynchronous (it
/// returns a promise). The promise arm must come *first*: `Either` picks the
/// first arm whose value validates, and the `Undefined` arm accepts anything.
pub type EventReturn = Either<Promise<()>, Undefined>;

pub mod client;
pub mod media_session;

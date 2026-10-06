//! A generic D-Bus client.
//!
//! Unlike [`crate::media_session`], which *serves* the MPRIS interfaces, this
//! module talks to arbitrary services: it can call any method, read or write
//! any property, and subscribe to any signal on the session or system bus.
//!
//! Values cross the JS boundary as signature-driven plain JS values; see
//! [`value`] for the exact rules.

mod value;

use napi::bindgen_prelude::{Either, Either as NapiEither, Object, Promise, Undefined};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Error, Result};
use napi_derive::napi;
use serde_json::{json, Value as Json};
use smol::stream::StreamExt;
use zbus::message::{Body, Message, Type};
use zbus::zvariant::{OwnedStructure, Signature};
use zbus::{Connection, MatchRule, MessageStream};

/// The interface every D-Bus object exposes for properties.
const PROPERTIES_INTERFACE: &str = "org.freedesktop.DBus.Properties";
/// The interface every D-Bus object exposes for introspection.
const INTROSPECTABLE_INTERFACE: &str = "org.freedesktop.DBus.Introspectable";

/// Arguments for [`DbusClient::call`].
#[napi(object)]
pub struct DbusCallOptions {
    /// Well-known or unique name of the service to call.
    pub destination: String,
    /// Object path of the object that owns the method.
    pub path: String,
    /// Interface the method belongs to.
    pub interface_name: String,
    /// Method name.
    pub method: String,
    /// D-Bus signature of the arguments, e.g. `"sa{sv}"`. Defaults to none.
    pub signature: Option<String>,
    /// One element per argument described by `signature`. Defaults to none.
    #[napi(ts_type = "unknown[]")]
    pub body: Option<Vec<Json>>,
}

/// The reply to a method call.
#[napi(object)]
pub struct DbusMessage {
    /// D-Bus signature of the reply body.
    pub signature: String,
    /// One element per reply argument.
    #[napi(ts_type = "unknown[]")]
    pub body: Vec<Json>,
}

/// A D-Bus variant: a value together with its own signature.
#[napi(object)]
pub struct DbusVariant {
    /// D-Bus signature of `value`.
    pub signature: String,
    /// The value, shaped according to `signature`.
    #[napi(ts_type = "unknown")]
    pub value: Json,
}

/// Arguments for [`DbusClient::getProperty`].
#[napi(object)]
pub struct DbusPropertyOptions {
    /// Well-known or unique name of the service to call.
    pub destination: String,
    /// Object path of the object that owns the property.
    pub path: String,
    /// Interface that declares the property.
    pub interface_name: String,
    /// Property name.
    pub name: String,
}

/// Arguments for [`DbusClient::setProperty`].
#[napi(object)]
pub struct DbusSetPropertyOptions {
    /// Well-known or unique name of the service to call.
    pub destination: String,
    /// Object path of the object that owns the property.
    pub path: String,
    /// Interface that declares the property.
    pub interface_name: String,
    /// Property name.
    pub name: String,
    /// D-Bus signature of `value`.
    pub signature: String,
    /// The new value, shaped according to `signature`.
    #[napi(ts_type = "unknown")]
    pub value: Json,
}

/// What signals a subscription listens for. Every field is optional; an empty
/// match receives every signal on the bus.
#[napi(object)]
pub struct DbusSignalMatch {
    /// Only signals sent by this service.
    pub sender: Option<String>,
    /// Only signals emitted from this object path.
    pub path: Option<String>,
    /// Only signals from this interface.
    pub interface_name: Option<String>,
    /// Only this signal name.
    pub member: Option<String>,
}

/// A signal delivered to a subscription handler.
#[napi(object)]
pub struct DbusSignal {
    /// The unique name of the connection that emitted the signal.
    pub sender: String,
    /// Object path the signal was emitted from.
    pub path: String,
    /// Interface the signal belongs to.
    pub interface_name: String,
    /// Signal name.
    pub member: String,
    /// D-Bus signature of `body`.
    pub signature: String,
    /// One element per signal argument.
    #[napi(ts_type = "unknown[]")]
    pub body: Vec<Json>,
}

/// A live signal subscription.
///
/// Dropping the handle (or calling [`DbusSubscription::unsubscribe`]) stops
/// the subscription and deregisters its match rule.
#[napi]
pub struct DbusSubscription {
    cancel: Option<smol::channel::Sender<()>>,
}

impl DbusSubscription {
    fn new(cancel: smol::channel::Sender<()>) -> Self {
        Self {
            cancel: Some(cancel),
        }
    }
}

#[napi]
impl DbusSubscription {
    /// Stop receiving signals. Calling this more than once is a no-op.
    #[napi]
    pub fn unsubscribe(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            // The receiver is only polled inside the subscription task, which
            // exits as soon as it sees the message; a failure means the task is
            // already gone, which is just as good.
            let _ = cancel.try_send(());
        }
    }

    /// Whether this subscription is still listening.
    #[napi(getter)]
    pub fn active(&self) -> bool {
        self.cancel
            .as_ref()
            .is_some_and(|cancel| !cancel.is_closed())
    }
}

/// A connection to the D-Bus session or system bus.
///
/// Calls are asynchronous and reject with the D-Bus error name and message
/// (for example `"org.freedesktop.DBus.Error.UnknownMethod: …"`).
#[napi]
pub struct DbusClient {
    conn: Connection,
}

#[napi]
impl DbusClient {
    /// Connect to a bus. `bus` is `"session"` (the default) or `"system"`.
    #[napi(constructor, ts_args_type = "bus?: \"session\" | \"system\"")]
    pub fn new(bus: Option<String>) -> Result<Self> {
        let bus = bus.unwrap_or_else(|| "session".to_string());
        let conn = match bus.as_str() {
            "session" => smol::block_on(Connection::session()),
            "system" => smol::block_on(Connection::system()),
            other => {
                return Err(Error::from_reason(format!(
                    "unknown bus {other:?}: expected \"session\" or \"system\""
                )))
            }
        }
        .map_err(|e| Error::from_reason(e.to_string()))?;

        Ok(Self { conn })
    }

    /// Call a method and resolve with its reply.
    #[napi(ts_return_type = "Promise<DbusMessage>")]
    pub fn call<'a>(&'a self, env: &'a Env, options: DbusCallOptions) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        napi_deferred_task!(env, async move {
            let DbusCallOptions {
                destination,
                path,
                interface_name,
                method,
                signature,
                body,
            } = options;
            let signature = signature.unwrap_or_default();
            let body = body.unwrap_or_default();

            call_method(
                &conn,
                &destination,
                &path,
                &interface_name,
                &method,
                &signature,
                &body,
            )
            .await
        })
    }

    /// Read a property, resolving with the variant it currently holds.
    #[napi(ts_return_type = "Promise<DbusVariant>")]
    pub fn get_property<'a>(
        &'a self,
        env: &'a Env,
        options: DbusPropertyOptions,
    ) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        napi_deferred_task!(env, async move {
            let DbusPropertyOptions {
                destination,
                path,
                interface_name,
                name,
            } = options;
            let reply = call_method(
                &conn,
                &destination,
                &path,
                PROPERTIES_INTERFACE,
                "Get",
                "ss",
                &[Json::from(interface_name), Json::from(name)],
            )
            .await?;

            variant_from_message(&reply)
        })
    }

    /// Write a property.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn set_property<'a>(
        &'a self,
        env: &'a Env,
        options: DbusSetPropertyOptions,
    ) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        napi_deferred_task!(env, async move {
            let DbusSetPropertyOptions {
                destination,
                path,
                interface_name,
                name,
                signature,
                value,
            } = options;
            let variant = json!({ "signature": signature, "value": value });

            call_method(
                &conn,
                &destination,
                &path,
                PROPERTIES_INTERFACE,
                "Set",
                "ssv",
                &[Json::from(interface_name), Json::from(name), variant],
            )
            .await?;

            Ok::<(), String>(())
        })
    }

    /// Read an object's introspection XML.
    #[napi(ts_return_type = "Promise<string>")]
    pub fn introspect<'a>(
        &'a self,
        env: &'a Env,
        destination: String,
        path: String,
    ) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        napi_deferred_task!(env, async move {
            let reply = call_method(
                &conn,
                &destination,
                &path,
                INTROSPECTABLE_INTERFACE,
                "Introspect",
                "",
                &[],
            )
            .await?;

            match reply.body.into_iter().next() {
                Some(Json::String(xml)) => Ok(xml),
                _ => Err("Introspect did not return XML".to_string()),
            }
        })
    }

    /// Subscribe to signals matching `matches`.
    ///
    /// The handler is called with `(null, signal)` for every matching signal
    /// and may be asynchronous; signals are handed over one at a time, in the
    /// order they arrive, and the subscription waits for each handler to
    /// settle before the next one. A handler that throws is ignored — a signal
    /// has no caller to report the failure to — and does not stop the
    /// subscription.
    ///
    /// Resolves once the bus has registered the match rule, so a subscription
    /// never silently misses signals emitted right after it resolves.
    #[napi(ts_return_type = "Promise<DbusSubscription>")]
    pub fn subscribe<'a>(
        &'a self,
        env: &'a Env,
        matches: DbusSignalMatch,
        handler: ThreadsafeFunction<DbusSignal, Either<Promise<()>, Undefined>>,
    ) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        let (deferred, object) = env.create_deferred()?;

        smol::spawn(async move {
            let rule = match build_match_rule(&matches) {
                Ok(rule) => rule,
                Err(error) => {
                    deferred.reject(Error::from_reason(error));
                    return;
                }
            };
            let stream = match MessageStream::for_match_rule(rule, &conn, None).await {
                Ok(stream) => stream,
                Err(error) => {
                    deferred.reject(Error::from_reason(error.to_string()));
                    return;
                }
            };
            let mut stream = Box::pin(stream);

            let (cancel, stop) = smol::channel::bounded(1);
            deferred.resolve(move |_env| Ok(DbusSubscription::new(cancel)));

            loop {
                // `or` needs both futures to yield the same type, so the
                // cancellation is mapped onto the stream's item type.
                let stopped = async {
                    let _ = stop.recv().await;
                    None::<zbus::Result<Message>>
                };
                let Some(message) = smol::future::or(stream.next(), stopped).await else {
                    break;
                };
                // `Some(Err(_))` means the stream failed or ended; the
                // connection closing also ends it.
                let Ok(message) = message else {
                    break;
                };
                let signal = match signal_from_message(&message) {
                    Ok(signal) => signal,
                    // A signal we cannot represent in JS is skipped rather
                    // than allowed to end the subscription.
                    Err(_) => continue,
                };
                // A handler may return a promise that never settles. Waiting
                // for it has to stay cancellable too, otherwise `unsubscribe`
                // could never stop the task and release its match rule.
                let handling = async {
                    if let Ok(NapiEither::A(promise)) = handler.call_async(Ok(signal)).await {
                        let _ = promise.await;
                    }
                };
                let cancelled = smol::future::or(
                    async {
                        handling.await;
                        false
                    },
                    async {
                        let _ = stop.recv().await;
                        true
                    },
                )
                .await;
                if cancelled {
                    break;
                }
            }
        })
        .detach();

        Ok(object)
    }

    /// Close the connection. Outstanding subscriptions stop receiving signals.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn disconnect<'a>(&'a self, env: &'a Env) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        napi_deferred_task!(
            env,
            async move { conn.close().await.map_err(|e| e.to_string()) }
        )
    }
}

/// Send a method call and decode its reply.
async fn call_method(
    conn: &Connection,
    destination: &str,
    path: &str,
    interface_name: &str,
    method: &str,
    signature: &str,
    body: &[Json],
) -> std::result::Result<DbusMessage, String> {
    let arguments = value::encode_args(signature, body)?;
    let reply = match &arguments {
        Some(arguments) => {
            conn.call_method(
                Some(destination),
                path,
                Some(interface_name),
                method,
                arguments,
            )
            .await
        }
        None => {
            conn.call_method(Some(destination), path, Some(interface_name), method, &())
                .await
        }
    }
    .map_err(|e| e.to_string())?;

    Ok(DbusMessage {
        signature: reply.body().signature().to_string_no_parens(),
        body: decode_body(&reply.body())?,
    })
}

/// Decode a message body into one JSON value per argument.
fn decode_body(body: &Body) -> std::result::Result<Vec<Json>, String> {
    if matches!(body.signature(), Signature::Unit) {
        return Ok(Vec::new());
    }

    let structure: OwnedStructure = body.deserialize().map_err(|e| e.to_string())?;
    value::structure_to_json(&structure.0)
}

/// `Properties.Get` answers with a single variant; unwrap it for JS.
fn variant_from_message(message: &DbusMessage) -> std::result::Result<DbusVariant, String> {
    let Some(Json::Object(variant)) = message.body.first() else {
        return Err("Properties.Get did not return a variant".to_string());
    };
    let signature = variant
        .get("signature")
        .and_then(Json::as_str)
        .ok_or_else(|| "Properties.Get returned a variant without a signature".to_string())?;
    let value = variant
        .get("value")
        .ok_or_else(|| "Properties.Get returned a variant without a value".to_string())?;

    Ok(DbusVariant {
        signature: signature.to_string(),
        value: value.clone(),
    })
}

/// Translate a signal message into the JS-facing shape.
fn signal_from_message(message: &Message) -> std::result::Result<DbusSignal, String> {
    let header = message.header();
    let body = message.body();

    Ok(DbusSignal {
        sender: header
            .sender()
            .map(|name| name.to_string())
            .unwrap_or_default(),
        path: header
            .path()
            .map(|path| path.to_string())
            .unwrap_or_default(),
        interface_name: header
            .interface()
            .map(|interface| interface.to_string())
            .unwrap_or_default(),
        member: header
            .member()
            .map(|member| member.to_string())
            .unwrap_or_default(),
        signature: body.signature().to_string_no_parens(),
        body: decode_body(&body)?,
    })
}

/// Build the bus-side match rule for a subscription.
fn build_match_rule(matches: &DbusSignalMatch) -> std::result::Result<MatchRule<'_>, String> {
    let mut builder = MatchRule::builder().msg_type(Type::Signal);

    if let Some(sender) = &matches.sender {
        builder = builder
            .sender(sender.as_str())
            .map_err(|e| format!("invalid signal sender {sender:?}: {e}"))?;
    }
    if let Some(path) = &matches.path {
        builder = builder
            .path(path.as_str())
            .map_err(|e| format!("invalid signal path {path:?}: {e}"))?;
    }
    if let Some(interface_name) = &matches.interface_name {
        builder = builder
            .interface(interface_name.as_str())
            .map_err(|e| format!("invalid signal interface {interface_name:?}: {e}"))?;
    }
    if let Some(member) = &matches.member {
        builder = builder
            .member(member.as_str())
            .map_err(|e| format!("invalid signal member {member:?}: {e}"))?;
    }

    Ok(builder.build())
}

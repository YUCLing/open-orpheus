# @open-orpheus/dbus

Module that provides D-Bus functionalities.

## Generic client

`DbusClient` talks to arbitrary services on the session (`"session"`, the
default) or system (`"system"`) bus: it can call any method, read or write any
property, and subscribe to any signal.

```js
import { DbusClient } from "@open-orpheus/dbus";

const bus = new DbusClient("session");

// No arguments, string reply: the call's signature describes its arguments.
const id = await bus.call({
  destination: "org.freedesktop.DBus",
  path: "/org/freedesktop/DBus",
  interfaceName: "org.freedesktop.DBus",
  method: "GetId",
});
// { signature: "s", body: ["20d88e95…"] }

// One string argument, boolean reply: "s" -> "b".
const hasOwner = await bus.call({
  destination: "org.freedesktop.DBus",
  path: "/org/freedesktop/DBus",
  interfaceName: "org.freedesktop.DBus",
  method: "NameHasOwner",
  signature: "s",
  body: ["com.example.Player"],
});
// hasOwner.body[0] === true

// Properties, without spelling out the Properties interface.
const volume = await bus.getProperty({
  destination: "com.example.Player",
  path: "/org/mpris/MediaPlayer2",
  interfaceName: "org.mpris.MediaPlayer2.Player",
  name: "Volume",
});
// { signature: "d", value: 0.5 }
await bus.setProperty({
  destination,
  path,
  interfaceName,
  name: "Volume",
  signature: "d",
  value: 0.5,
});

// Signals. The handler is called as `(err, signal)` and may be asynchronous;
// signals are handed over one at a time, in arrival order.
const subscription = await bus.subscribe(
  {
    sender: "org.freedesktop.DBus",
    interfaceName: "org.freedesktop.DBus",
    member: "NameOwnerChanged",
  },
  (_err, signal) => console.log(signal.member, signal.body)
);
subscription.unsubscribe();
```

`bus.introspect(destination, path)` returns an object's raw introspection XML,
and `bus.disconnect()` closes the connection.

### Values

Values cross the boundary as plain JS values shaped by the D-Bus signature; the
`signature` option on `call` describes the arguments, and every reply reports
the signature it arrived with.

| signature   | JS value                                           |
| ----------- | -------------------------------------------------- |
| `y n q i u` | number                                             |
| `x t`       | number, or bigint outside the ±2^53 safe range     |
| `d`         | number                                             |
| `b`         | boolean                                            |
| `s o g`     | string                                             |
| `v`         | `{ signature, value }`                             |
| `aX`        | array (`ay` is a `number[]`)                       |
| `a{KV}`     | object when `K` is `s`/`o`/`g`, else `[[k, v], …]` |
| `(…)`       | array with one element per field                   |
| `h`         | `null` when decoded, rejected when encoded         |

The `x t` row is lossless: a value outside the ±2^53 safe integer range crosses
as a `bigint`, so callers must handle either `number` or `bigint`. On input, a
`t` value passed as a `bigint` above `2^63 - 1` is rejected rather than
silently truncated.

Only variants need the `{ signature, value }` wrapper: every other shape is
implied by the signature it belongs to. A top-level `"(is)"` is one struct
argument, while `"is"` is two arguments.

A D-Bus body signature is always a field list, so a reply whose only argument is
a struct is reported as that struct's fields (`body: [42, "x"]`, `signature:
"is"`) rather than as a nested array.

Failures reject with the D-Bus error name and message (for example
`org.freedesktop.DBus.Error.UnknownMethod: …`); invalid signatures, wrong
argument counts, and mistyped or out-of-range values reject with an error
naming the offending argument.

A signal handler that throws is ignored — there is no caller to report the
failure to — and does not stop the subscription. Dropping the subscription
handle stops it too.

## MPRIS event handling

`MediaSession` exposes the `org.mpris.MediaPlayer2` interfaces and reports
commands coming from the bus (play, pause, seek, volume, …) to JavaScript
through the handler registered with `setEventHandler`.

A D-Bus reply is only sent once that handler has finished running, so a client
observes the command as handled — or as failed, when the handler throws or
returns a rejected promise. The handler may therefore be asynchronous; returning
a promise makes the reply wait for the promise to settle.

The handler is free to call back into `MediaSession` (for example to report the
new `volume` from `setVolume`) while a command is in flight. Property updates
go through shared state and never wait on an in-flight command.

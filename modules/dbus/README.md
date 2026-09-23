# @open-orpheus/dbus

Module that provides D-Bus functionalities.

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

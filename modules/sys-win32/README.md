# @open-orpheus/system-win32

Windows system integration for Open Orpheus: the media session (SMTC) and powering the
machine off for the auto-exit countdown.

## `MediaSession`

The System Media Transport Controls session, driven through a `MediaPlayer`:

- `new MediaSession()`, `setEventHandler(handler)`, `setMetadata(metadata | null)`,
  `setPlaybackStatus(status)`, `setPlaybackRate(rate)`,
  `setTimelineProperties(position, duration)` (100 ns ticks).
- Events arrive as `MediaSessionEvents` (`Play`, `Pause`, `Next`, `Previous`, `Stop`,
  `SetPosition`, `SetRate`).

## Power-off

The deadline belongs to the app's own auto-exit countdown
([`src/main/shutdown.ts`](../../src/main/shutdown.ts)), which makes the two calls
below; this module holds no shutdown of its own while that countdown runs.

- `canShutdown(): boolean` — reports whether this process may power the machine off.
  Finding out means enabling `SeShutdownPrivilege`, which interactive users hold but
  Windows leaves disabled, so no elevation is involved. Idempotent, and the privilege
  stays enabled for the process. Throws when the process token cannot be queried.
- `shutdownNow(message: string, forceAppsClosed: boolean): void` — powers the machine
  off immediately, through `InitiateSystemShutdownExW` with a zero timeout: no
  countdown dialog appears, and the request cannot be aborted afterwards. `message` is
  shown by Windows while it shuts down, and `forceAppsClosed` decides whether
  applications with unsaved changes are closed or left to block the shutdown. The
  shutdown is recorded as planned. Throws when the request is refused — except when a
  shutdown is already in progress, which counts as success because the machine is going
  down either way.

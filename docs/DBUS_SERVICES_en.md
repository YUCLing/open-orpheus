# D-Bus Services

On Linux, Open Orpheus publishes MPRIS playback controls and a read-only lyrics service on the session bus for desktop widgets, external lyric displays, and scripts. Services are registered when the app starts; there is no extra toggle.

> Runtime introspection is the authoritative interface definition. This document and the XML snapshot checked into the repository are for reading and code generation only. If they disagree with the running service, trust runtime introspection.

## MPRIS playback modes

The normal installation uses bus name `org.mpris.MediaPlayer2.open-orpheus`,
object path `/org/mpris/MediaPlayer2`, and interface `org.mpris.MediaPlayer2.Player`.
Flatpak uses `org.mpris.MediaPlayer2.<FLATPAK_ID>` as its bus name.

`Shuffle` and `LoopStatus` are writable and publish actual changes through
`PropertiesChanged`. A write completes after the renderer confirms the mode;
unavailable integration, a three-second confirmation timeout, or an invalid
value returns an error. In-app changes are also published.

| Renderer mode | `Shuffle` | `LoopStatus` |
| --- | --- | --- |
| Sequential | `false` | `None` |
| Repeat playlist | `false` | `Playlist` |
| Repeat track | `false` | `Track` |
| Random | `true` | `Playlist` |

Orpheus has mutually exclusive modes. Enabling shuffle exits track repeat;
disabling shuffle returns to playlist repeat. Setting `Track` or `None` exits
shuffle; setting `Playlist` preserves existing shuffle. Heartbeat and FM have
no exact MPRIS equivalent and report `false` / `None`.

```sh
busctl --user set-property org.mpris.MediaPlayer2.open-orpheus \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player Shuffle b true

busctl --user set-property org.mpris.MediaPlayer2.open-orpheus \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player LoopStatus s Track
```

The renderer bridge currently targets Orpheus's webpack 4 runtime. It discovers
the initialized playing store by shape and dispatches the page's own
`playing/switchPlayingMode` action, without fixed module IDs or resource-pack
rewrites. Discovery stops after 30 seconds; a successful connection subscribes
to store changes without polling. Revalidate this bridge when the resource pack
changes its runtime framework.

## Lyrics service

| Item        | Value                                   |
| ----------- | --------------------------------------- |
| Bus         | Session bus (`--session` / `--user`)    |
| Bus name    | `io.github.yucling.OpenOrpheus`         |
| Object path | `/io/github/yucling/OpenOrpheus/Lyrics` |
| Interface   | `io.github.yucling.OpenOrpheus.Lyrics`  |
| Platform    | Linux                                   |
| Access      | Read-only                               |

### Inspect the interface

```sh
gdbus introspect \
  --session \
  --dest io.github.yucling.OpenOrpheus \
  --object-path /io/github/yucling/OpenOrpheus/Lyrics

busctl --user introspect \
  io.github.yucling.OpenOrpheus \
  /io/github/yucling/OpenOrpheus/Lyrics
```

A generated XML snapshot is also checked in at
[`docs/resources/dbus/io.github.yucling.OpenOrpheus.Lyrics.xml`](./resources/dbus/io.github.yucling.OpenOrpheus.Lyrics.xml).

### Quick start

```sh
# Current lyrics (JSON string)
gdbus call \
  --session \
  --dest io.github.yucling.OpenOrpheus \
  --object-path /io/github/yucling/OpenOrpheus/Lyrics \
  --method io.github.yucling.OpenOrpheus.Lyrics.GetLyrics

# The lyric line at a playback position (milliseconds)
gdbus call \
  --session \
  --dest io.github.yucling.OpenOrpheus \
  --object-path /io/github/yucling/OpenOrpheus/Lyrics \
  --method io.github.yucling.OpenOrpheus.Lyrics.GetLineAt \
  12345

# Read a property
gdbus call \
  --session \
  --dest io.github.yucling.OpenOrpheus \
  --object-path /io/github/yucling/OpenOrpheus/Lyrics \
  --method org.freedesktop.DBus.Properties.Get \
  io.github.yucling.OpenOrpheus.Lyrics \
  Available

busctl --user get-property \
  io.github.yucling.OpenOrpheus \
  /io/github/yucling/OpenOrpheus/Lyrics \
  io.github.yucling.OpenOrpheus.Lyrics \
  Available

# Watch signals
gdbus monitor --session --dest io.github.yucling.OpenOrpheus
```

> **Units:** every time value in this service is in **milliseconds**. MPRIS `Position` is in microseconds, so convert it before calling `GetLineAt`.

### Methods

| Method      | Arguments       | Returns | Description                                                                       |
| ----------- | --------------- | ------- | --------------------------------------------------------------------------------- |
| `GetLyrics` | none            | `s`     | JSON lyrics document; the string `"null"` when no lyrics are available            |
| `GetLineAt` | `x position_ms` | `s`     | JSON lyric line at the given millisecond position; `"null"` before the first line |

`GetLyrics` returns JSON in the app's `LyricsStore` shape (all times in milliseconds):

```json
{
  "regular": [
    {
      "start_time": 0,
      "end_time": 5000,
      "words": [{ "text": "hello", "start_time": 0, "duration": 5000 }]
    }
  ],
  "per-word": [
    {
      "start_time": 0,
      "end_time": 5000,
      "words": [
        { "text": "he", "start_time": 0, "duration": 2000 },
        { "text": "llo", "start_time": 2000, "duration": 3000 }
      ]
    }
  ],
  "translate": [],
  "roma": []
}
```

`per-word`, `translate`, and `roma` are omitted when unavailable. `words[].start_time` is relative to its line.

`GetLineAt` returns JSON:

```json
{
  "index": 0,
  "start_time": 0,
  "end_time": 5000,
  "text": "hello",
  "translation": "你好",
  "roma": null,
  "words": [{ "text": "hello", "start_time": 0, "duration": 5000 }]
}
```

- `index` is the line's position in the primary lines (per-word lines when available, otherwise regular lines).
- After the last line ends, the last line is still returned, matching the in-app display.
- `translation`/`roma` are `null` when unavailable.

### Properties

| Property         | Type | Description                                      |
| ---------------- | ---- | ------------------------------------------------ |
| `Available`      | `b`  | Whether primary lyric lines are available        |
| `Slogan`         | `s`  | Current slogan, empty when none                  |
| `TrackId`        | `s`  | Current play id, empty when none                 |
| `Title`          | `s`  | Track title                                      |
| `Artist`         | `s`  | Track artist                                     |
| `Album`          | `s`  | Track album                                      |
| `Duration`       | `x`  | Track duration in milliseconds; `0` when unknown |
| `HasPerWord`     | `b`  | Whether per-word lyrics are available            |
| `HasTranslation` | `b`  | Whether translation lyrics are available         |
| `HasRoma`        | `b`  | Whether romanization lyrics are available        |

Property changes emit the standard `org.freedesktop.DBus.Properties.PropertiesChanged` signal.

### Signals

| Signal          | Arguments | Emitted when                          |
| --------------- | --------- | ------------------------------------- |
| `LyricsChanged` | none      | The lyrics document or slogan changed |
| `TrackChanged`  | none      | Track metadata or duration changed    |

Signals carry no payload; call `GetLyrics` or read the properties again after receiving one. This avoids broadcasting large lyric documents over the bus.

### JavaScript client example

```js
import { DbusClient } from "@open-orpheus/dbus";

const bus = new DbusClient("session");
const target = {
  destination: "io.github.yucling.OpenOrpheus",
  path: "/io/github/yucling/OpenOrpheus/Lyrics",
  interfaceName: "io.github.yucling.OpenOrpheus.Lyrics",
};

const lyrics = await bus.call({ ...target, method: "GetLyrics" });
const store = JSON.parse(lyrics.body[0]);

// Pass a millisecond position converted from MPRIS.
const line = await bus.call({
  ...target,
  method: "GetLineAt",
  signature: "x",
  body: [12345],
});
console.log(JSON.parse(line.body[0]));
```

## Relationship to MPRIS

Playback status, position, and control commands remain available through MPRIS (`org.mpris.MediaPlayer2.open-orpheus`). The lyrics service only provides the lyrics document, track metadata, and position-based lookup. It has no timer and sends no continuous position signals.

> On a track change, the service first clears the previous song's lyrics and slogan. Content only reappears when the renderer supplies new lyrics. This prevents returning the previous song's lyrics when desktop lyrics, the player page, or the mini player is not enabled.

## Stability

- Adding methods, properties, or signals under the same interface name is considered backward-compatible.
- Breaking changes use a new interface name and are called out in the release notes.
- Runtime introspection always takes precedence over this document and the XML snapshot. If they disagree, trust the running service and please open an issue.

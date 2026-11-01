# MPRIS playback modes

[中文版本](MPRIS.md)

The normal installation uses bus name `org.mpris.MediaPlayer2.open-orpheus`,
object path `/org/mpris/MediaPlayer2`, and interface `org.mpris.MediaPlayer2.Player`.
Flatpak uses `org.mpris.MediaPlayer2.<FLATPAK_ID>` as its bus name.

`Shuffle` and `LoopStatus` are writable and publish actual changes through
`PropertiesChanged`. A write completes after the renderer confirms the mode;
unavailable integration, a three-second confirmation timeout, or an invalid
value returns an error. In-app changes are also published.

| Renderer mode   | `Shuffle` | `LoopStatus` |
| --------------- | --------- | ------------ |
| Sequential      | `false`   | `None`       |
| Repeat playlist | `false`   | `Playlist`   |
| Repeat track    | `false`   | `Track`      |
| Random          | `true`    | `Playlist`   |

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

The renderer bridge finds the playing store through the mounted React Fiber tree,
then subscribes to state changes and dispatches `playing/switchPlayingMode`.
It is installed in the main Orpheus page on every platform; the MPRIS adapter
is used on Linux. Discovery runs for up to 30 seconds.

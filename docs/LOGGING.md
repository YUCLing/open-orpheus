# Logging

Open Orpheus writes logs with [pino](https://getpino.io/). The main process owns
the logger; preload scripts forward their records to it over IPC.

By default:

- level: `info`
- console: pretty output on a TTY, NDJSON otherwise
- file: `latest.ndjson` in the data directory's `logs` folder, rotated at startup
  and compressed to `.ndjson.gz`
- rotated logs retained: 5

Log directory:

- development: `data/logs/`
- packaged: `{userData}/logs/`

## Environment variables

Set these before launching the application.

| Variable                         | Values                                                       | Default  | Description                                              |
| -------------------------------- | ------------------------------------------------------------ | -------- | -------------------------------------------------------- |
| `OPEN_ORPHEUS_LOG_LEVEL`         | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | `info`   | Default level for every sink                             |
| `OPEN_ORPHEUS_LOG_LEVEL_CONSOLE` | same as above                                                | inherits | Console sink level; `silent` disables the console sink   |
| `OPEN_ORPHEUS_LOG_LEVEL_FILE`    | same as above                                                | inherits | File sink level; `silent` disables the file sink         |
| `OPEN_ORPHEUS_LOG_FORMAT`        | `auto`, `json`, `pretty`                                     | `auto`   | Console format. `auto` = pretty on a TTY, JSON otherwise |

Values are case-insensitive and trimmed. Invalid values fall back to the
default and emit a warning instead of failing startup.

`OPEN_ORPHEUS_FORCE_PRETTY` has been removed. Use
`OPEN_ORPHEUS_LOG_FORMAT=pretty` instead.

## Level precedence

`OPEN_ORPHEUS_LOG_LEVEL` is the default. The console/file variables override it,
even when they are more verbose:

```sh
OPEN_ORPHEUS_LOG_LEVEL=info \
OPEN_ORPHEUS_LOG_LEVEL_CONSOLE=info \
OPEN_ORPHEUS_LOG_LEVEL_FILE=debug \
open-orpheus
```

Pino filters at the logger level before the transports, so the logger's base
level becomes the most verbose active sink and each transport filters its own
records. The example above writes `debug` records to the file and `info` records
to the console.

A sink-specific level can also re-enable a globally silent sink:

```sh
OPEN_ORPHEUS_LOG_LEVEL=silent \
OPEN_ORPHEUS_LOG_LEVEL_FILE=debug \
open-orpheus
```

This writes only the file. Set `OPEN_ORPHEUS_LOG_LEVEL=silent` (or all three
levels) to disable logging completely.

Setting a sink to `silent` disables that sink. When the file sink is disabled,
startup rotation and retention are skipped for that run; existing archives are
left alone.

## Examples

Verbose console output while keeping the file at `info`:

```sh
OPEN_ORPHEUS_LOG_LEVEL=info \
OPEN_ORPHEUS_LOG_LEVEL_CONSOLE=debug \
open-orpheus
```

Trace everything into the rotating file, with no console output:

```sh
OPEN_ORPHEUS_LOG_LEVEL_FILE=trace \
OPEN_ORPHEUS_LOG_LEVEL_CONSOLE=silent \
open-orpheus
```

Force pretty console output when stdout is piped:

```sh
OPEN_ORPHEUS_LOG_FORMAT=pretty open-orpheus
```

Force NDJSON even on a terminal:

```sh
OPEN_ORPHEUS_LOG_FORMAT=json open-orpheus
```

Flatpak:

```sh
flatpak run \
  --env=OPEN_ORPHEUS_LOG_LEVEL=debug \
  io.github.yucling.open-orpheus
```

Windows PowerShell:

```powershell
$env:OPEN_ORPHEUS_LOG_LEVEL = "debug"
$env:OPEN_ORPHEUS_LOG_LEVEL_CONSOLE = "debug"
```

When launching from a desktop entry, the variables must be present in that
entry's environment (for example, prefix `Exec=` with `env ...`). Launching
from a terminal is the simplest way to test them.

## Notes

- `trace` is very verbose. Retention runs at startup, so a long trace session
  produces a large `latest.ndjson` until the next launch.
- File writes are asynchronous; pending records are flushed on shutdown.
- The number of retained rotated logs is intentionally fixed at 5.
- Preload logs are forwarded to the main process. The main logger's level
  decides what is written, but the IPC message is still sent.

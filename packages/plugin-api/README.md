# @open-orpheus/plugin-api

Type-only API for [Open Orpheus](https://github.com/YUCLing/open-orpheus) plugins.
The package is generated from the host and contains no runtime code.

## Install

```sh
npm install --save-dev @open-orpheus/plugin-api
```

## Usage

Main realm:

```ts
import type { PluginModule, PluginRuntime } from "@open-orpheus/plugin-api";

export const activate: PluginModule["activate"] = async (runtime: PluginRuntime) => {
  const { default: logger } = await runtime.registry.load("@main/logger");
  logger.info("plugin activated");
};
```

Use `LoadedModule` when a host module's type is needed without loading it:

```ts
import type { LoadedModule } from "@open-orpheus/plugin-api";

type Logger = LoadedModule<"@main/logger">;
// same as Awaited<ReturnType<RegistryLoad["@main/logger"]>>
```

Preload realm:

```ts
import type { PluginModule, PluginRuntime } from "@open-orpheus/plugin-api/preload";
```

Plugin-manager realm:

```ts
import type { PluginModule, PluginRuntime } from "@open-orpheus/plugin-api/plugin-manager";
```

The plugin-manager realm runs only in the plugin manager window. Declare it in
`metadata.json` as a `plugin-manager` entry; it is optional and separate from
the main and preload entries.

## Deep imports and stability

The generated tree mirrors the host's module graph, so implementation types can
be imported directly through the package wildcard:

```ts
import type { PlaybackMode } from "@open-orpheus/plugin-api/host/src/shared/types/playback-mode.js";
import type PlaybackController from "@open-orpheus/plugin-api/host/src/main/playback/PlaybackController.js";
```

Include the `.js` extension: the package is ESM and the emitted declarations use
explicit specifiers. These are type-only imports; the package ships no runtime
code.

Deep imports are **not** part of the supported plugin API. Declarations tagged
`@internal` in the host, and implementation modules such as
`host/src/main/plugin/**`, are published only because the tree is generated from
the host source. The tag is a stability marker, not access control: the
declaration remains importable. These entries are **more unstable than the rest
of the generated surface** — the package entry points and registry keys. They
can change, move, or disappear in any release without a deprecation cycle.
Prefer `PluginModule`, `PluginRuntime`, `Registry`, `LoadedModule`, and the
generated registry keys for anything a plugin depends on.

In the generated declarations, enums are literal union types, so host
signatures accept their values directly:

```ts
import type { PlaybackStatus } from "@open-orpheus/plugin-api/host/src/main/playback/types.js";

const status: PlaybackStatus = "playing";
```

Normal enums also keep a `declare const` object and a namespace of member type
aliases, so values loaded from the registry retain their literal types and
`Enum.Member` still works in type positions; the package still ships no runtime
code. Numeric enums keep their reverse index, so `Enum[value]` remains valid.
`const enum`s are union-only; neither their values nor their `Enum.Member` type
names are available.

## Lifecycle

`activate` runs for each realm instance. `deactivate` is optional, but should be
idempotent and undo everything that `activate` registered.

Activation and cleanup are serialized: the host never calls `deactivate` while
the matching `activate` is still running. If activation exceeds the host's
deadline the plugin is reported as hung; cleanup starts only after activation
settles. A disable received during activation is applied immediately after that
activation finishes.

Main-realm entries (and renderer configuration modules) are imported with a
cache-busting `?t=<timestamp>-<rand>` query, so each enable/disable cycle
evaluates the entry afresh. Within one enable epoch, activation and cross-plugin
`load()` share a single evaluation. Top-level code therefore runs again on every
enable: keep it declarative and put setup in `activate()` and teardown in
`deactivate()`.

Only the entry is cache-busted. Modules the entry imports resolve without the
query and keep their first evaluation for the life of the process (main realm) or
window document (configuration UI). So:

- Module-level state in an imported helper survives disable/enable. Keep
  per-activation state in the entry or in `activate()`.
- Never create listeners, timers, IPC handlers, or `contextBridge` APIs at the
  top level of an imported module; that code does not run again, while the entry
  that owns it does.
- `deactivate()` must clean up explicitly; do not rely on imported modules being
  reset.
- Build output matters: shared chunks or separate lazy-import chunks are exactly
  these uncached modules. Inlining each entry (no code splitting) makes all of
  its code re-evaluate, at the cost of bundle size; otherwise treat every emitted
  chunk as a process-lifetime singleton.

Preload and plugin-manager bundles are CommonJS evaluated by the host and are
re-evaluated after a full disable, but not on retry. Editing plugin files
requires restarting the realm or application.

## Cross-plugin exports

`runtime.plugins` exposes two distinct operations:

```ts
await runtime.plugins.load("other-plugin"); // evaluate and return exports
await runtime.plugins.whenActive("other-plugin"); // wait until it is running
```

`load` does not wait for the other plugin's `activate`. Use `whenActive` when
your plugin needs the other plugin to be fully initialized. Readiness cycles
fail immediately with an `Activation readiness cycle` error instead of timing
out.

## Configuration UI

Declare the panel in `metadata.json`, relative to the plugin's `assets/`
directory and as an `.mjs` file:

```json
"configuration": "configuration/index.mjs"
```

That module is browser ESM the host imports and owns. Export `mount()` and return
a cleanup function, or nothing:

```ts
import type { ConfigurationModule } from "@open-orpheus/plugin-api/configuration";

export const mount: ConfigurationModule["mount"] = (root, context) => {
  root.textContent = "Settings";
  return () => {
    root.replaceChildren();
  };
};
```

There is no registration API. `context` provides `pluginId`, `assetsBaseUrl`
(the plugin's `assets/` root), and an `AbortSignal`. The host awaits the returned
cleanup and reports failures per plugin. If you need host data, expose it from the
plugin-manager preload realm through `contextBridge`; the host activates that
realm before mounting the panel.

## Versioning

The package version matches the Open Orpheus release it was generated from.

## Publishing

Releases are staged on npm by the release workflow, synchorized with Open Orpheus's release.

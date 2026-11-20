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

## Lifecycle

`activate` runs for each realm instance. `deactivate` is optional, but should be
idempotent and undo everything that `activate` registered.

Activation and cleanup are serialized: the host never calls `deactivate` while
the matching `activate` is still running. If activation exceeds the host's
deadline the plugin is reported as hung; cleanup starts only after activation
settles. A disable received during activation is applied immediately after that
activation finishes.

Re-enabling a main-realm plugin reactivates the same cached ESM module instance;
top-level side effects are not guaranteed to run again. Preload and
plugin-manager bundles are re-evaluated after a full disable. Editing plugin
files requires restarting the realm or application.

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

A plugin-manager realm plugin registers its configuration panel with the host
object injected into the window:

```ts
pluginManager.register("my-plugin-id", {
  configuration: {
    mount: (element) => {
      /* ... */ return unmount;
    },
  },
});
```

`register` throws if the id is already registered. Unregister in `deactivate`:

```ts
pluginManager.unregister("my-plugin-id");
```

## Versioning

The package version matches the Open Orpheus release it was generated from.

## Publishing

Releases are staged on npm by the release workflow, synchorized with Open Orpheus's release.

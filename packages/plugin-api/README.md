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
import type { PreloadPluginModule, PreloadPluginRuntime } from "@open-orpheus/plugin-api/preload";
```

Plugin-manager realm:

```ts
import type {
  PluginManagerPluginModule,
  PluginManagerPluginRuntime,
} from "@open-orpheus/plugin-api/plugin-manager";
```

The plugin-manager realm runs only in the plugin manager window. Declare it in
`metadata.json` as a `plugin-manager` entry; it is optional and separate from
the main and preload entries.

## Versioning

The package version matches the Open Orpheus release it was generated from.

## Publishing

Releases are staged on npm by the release workflow, synchorized with Open Orpheus's release.

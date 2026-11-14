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

Preload realm:

```ts
import type { PreloadPluginModule, PreloadPluginRuntime } from "@open-orpheus/plugin-api/preload";
```

## Versioning

The package version matches the Open Orpheus release it was generated from.

## Publishing

Releases are staged on npm by the release workflow, synchorized with Open Orpheus's release.

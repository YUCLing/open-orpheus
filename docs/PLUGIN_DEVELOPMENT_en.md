# Plugin Development

This guide covers the plugin manifest, the three plugin realms, the generated
type package, lifecycle behavior, configuration UI, packaging, and debugging.

[中文版本](./PLUGIN_DEVELOPMENT.md)

> **Experimental.** The plugin system is under active development. Expect
> breaking changes at any time, including manifest fields, realm behavior, the
> generated registry surface, and lifecycle semantics. Target a specific Open
> Orpheus release when possible and expect to update plugins after upgrades.

## Trust model

Plugins are **trusted local code**. They are not sandboxed and receive the same
authority as the host process:

- `main` plugins run in the Electron main process with full Node.js and
  Electron access.
- `preload` and `plugin-manager` plugins run in a preload context. Their bundles
  are evaluated as CommonJS and may `require("electron")`, but cannot require
  arbitrary Node modules.
- The plugin manager warns users that plugins have full system access.

Only install plugins you trust. There is no signing, permission system, or
integrity verification.

## Quick start

The primary way to create a plugin is the GitHub template repository:
[open-orpheus/example-plugin](https://github.com/open-orpheus/example-plugin).
It contains a complete, buildable plugin with all three realms and a
configuration panel.

### Create from the template

1. Generate a repository from the template, then clone it:

   ```sh
   gh repo create my-plugin --template open-orpheus/example-plugin --public --clone
   cd my-plugin
   ```

   On GitHub, you can also click **Use this template → Create a new repository**,
   or clone the template directly with `git clone`.

2. Install dependencies and build:

   ```sh
   pnpm install
   pnpm build
   pnpm check
   ```

3. Change `metadata.json` (`id`, `name`, and realm entries) and update the plugin
   id used by the configuration panel in `src/plugin-manager/ui.ts` and
   `src/plugin-manager/preload.ts`.

4. Copy `dist/` (or `dist.asar`) into the host's plugin directory and enable the
   plugin in **Manage Open Orpheus → Plugin Manager**.

The template repository root **is** the plugin package: `metadata.json`, `src/`,
`tsdown.config.ts`, and `dist/` live at the top level. In this monorepo the same
package is vendored as
[`packages/plugin-builtin-example-plugin`](../packages/plugin-builtin-example-plugin).

### Manual setup

If you are not using the template:

1. Create a directory with a `metadata.json` and a main entry.
2. Install the type package: `npm install --save-dev @open-orpheus/plugin-api`.
3. Build a deployable tree: `metadata.json`, your `.mjs`/`.cjs` entries, and
   optional assets.
4. Put the directory (or an `.asar` file) into the host's plugin directory.
5. Enable it in **Manage Open Orpheus → Plugin Manager**.

User plugins are disabled by default.

## Manifest

`metadata.json` at the root of the plugin tree:

```json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What the plugin does.",
  "author": "Your Name",
  "homepage": "https://example.com/my-plugin",
  "license": "MIT",
  "icon": "icon.png",
  "realms": {
    "main": "main/index.mjs",
    "preload": "preload/index.cjs",
    "plugin-manager": "plugin-manager/index.cjs"
  }
}
```

| Field         | Required | Notes                                                                                                                      |
| ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes      | Must start with a letter or digit and contain only letters, digits, `.`, `_`, `-`. Must be unique among installed plugins. |
| `name`        | yes      | Non-empty display name.                                                                                                    |
| `version`     | yes      | Non-empty string. Not semver-validated.                                                                                    |
| `description` | no       | Shown in the plugin manager.                                                                                               |
| `author`      | no       | Shown in the plugin manager.                                                                                               |
| `homepage`    | no       | Metadata only.                                                                                                             |
| `license`     | no       | Shown in the plugin manager.                                                                                               |
| `icon`        | no       | Path relative to the plugin's `assets/` directory.                                                                         |
| `realms`      | yes      | Must contain `main`.                                                                                                       |

Realm entry rules:

- `main` must be a `.mjs` file.
- `preload` and `plugin-manager` must be `.cjs` files.
- Paths must be relative and stay inside the plugin tree; absolute paths and
  traversal are rejected.
- Every declared entry must exist.

A plugin source is either an immediate child directory or a `.asar` file in the
plugin directory. Hidden entries are ignored.

## Realms

A plugin can provide up to three realm entries. The generated type package
exposes one import path per realm:

| Realm            | Import                                    | Runtime                         |
| ---------------- | ----------------------------------------- | ------------------------------- |
| `main`           | `@open-orpheus/plugin-api`                | Electron main process, ESM      |
| `preload`        | `@open-orpheus/plugin-api/preload`        | Every host preload context, CJS |
| `plugin-manager` | `@open-orpheus/plugin-api/plugin-manager` | Plugin manager preload, CJS     |

Each module exports `activate(runtime)` and optionally `deactivate()`.

### Main realm

```ts
import type { PluginModule, PluginRuntime } from "@open-orpheus/plugin-api";

export const activate: PluginModule["activate"] = async (runtime: PluginRuntime) => {
  const { default: logger } = await runtime.registry.load("@main/logger");
  logger.info("plugin activated");
};

export const deactivate: PluginModule["deactivate"] = () => {
  // Undo everything activate() registered.
};
```

### Preload realm

Preload bundles are CommonJS. Build them with a bundler configured for `cjs`
(see the example plugin's `tsdown.config.ts`).

```ts
import type { PluginModule, PluginRuntime } from "@open-orpheus/plugin-api/preload";
import { contextBridge } from "electron";

export const activate: PluginModule["activate"] = async (runtime: PluginRuntime) => {
  const { default: logger } = await runtime.registry.load("@preload/logger");
  logger.info("preload plugin activated");

  contextBridge.executeInMainWorld({
    func: function () {
      console.log("hello from the renderer main world");
    },
  });
};
```

`contextBridge.executeInMainWorld` receives a serialized function; it cannot
capture variables from the preload scope. Pass data explicitly.

### Plugin-manager realm

This realm runs only while the plugin manager window is open. It is the place to
register a configuration panel (see below). It runs in the plugin manager's
preload context, so renderer UI must either be injected with
`contextBridge.executeInMainWorld` or loaded as a renderer script served through
the plugin's `assets://` URLs.

## Host registry

`runtime.registry` exposes the host modules for the current realm. It is
generated per release from the host's actual exports, so the authoritative list
is the generated `RegistryLoad` type in `@open-orpheus/plugin-api`.

```ts
const { default: logger } = await runtime.registry.load("@main/logger");
const { isNCMUrl } = await runtime.registry.load("@main/util/url");
```

Use `LoadedModule<"...">` when you need a host module's type without importing
the module:

```ts
import type { LoadedModule } from "@open-orpheus/plugin-api";

type Logger = LoadedModule<"@main/logger">;
```

Keys are realm-scoped. The same alias can map to different modules in different
realms; import the type package for the realm you are writing.

## Cross-plugin exports

A plugin's entry exports are available to other plugins through
`runtime.plugins`:

```ts
// Evaluate and return the other plugin's exports. Does not wait for activate().
const exported = await runtime.plugins.load("com.example.other");

// Wait until the other plugin is running, then return its exports.
const ready = await runtime.plugins.whenActive("com.example.other");
```

- `load` is for ordinary module-style dependencies.
- `whenActive` is for dependencies on initialized services.
- A readiness cycle is rejected immediately with an
  `Activation readiness cycle: a -> b -> a` error rather than timing out.
- Unknown, disabled, or failed plugins reject with a descriptive error.

## Lifecycle and state

Desired state (enabled/disabled) is persisted separately from runtime state.

- `activate()` runs for each realm instance. `deactivate()` is optional and
  should be idempotent.
- The host serializes activation and cleanup. It never calls `deactivate()`
  while the matching `activate()` is still running.
- If activation exceeds the host deadline (currently 15 seconds), the plugin is
  reported as **hung**. Cleanup starts only after the activation settles, so a
  plugin that blocks forever cannot be forcibly stopped.
- Disabling while activation is in flight is applied as soon as activation
  finishes.
- A failed activation is **not retried automatically**. The plugin manager shows
  a retry action; enabling an already-enabled failed plugin is idempotent and
  does not retry.
- Cleanup failures are shown as failed cleanup, not as a successful disable.
- Re-enabling a main-realm plugin runs the hooks again on the same cached ESM
  module instance. Preload/plugin-manager bundles are re-evaluated after a full
  disable. Do not rely on top-level module side effects for per-activation setup;
  put setup in `activate()` and teardown in `deactivate()`.
- Plugin files are captured when a realm instance starts. Editing a plugin
  package requires restarting the plugin (disable/enable may re-read preload
  bundles, but the main ESM module and an already-open window's source snapshot
  are not hot-reloaded).

## Configuration UI

`window.pluginManager` exists only in the plugin manager window's **main world**,
not in the preload context where the plugin-manager realm runs. Inject a renderer
script from `assets/` and register there.

`src/plugin-manager/preload.ts`:

```ts
import type { PluginModule } from "@open-orpheus/plugin-api/plugin-manager";
import { contextBridge } from "electron";

export const activate: PluginModule["activate"] = () => {
  contextBridge.executeInMainWorld({
    func: function () {
      const script = document.createElement("script");
      script.src = "assets://plugins/com.example.my-plugin/ui.cjs";
      document.body.append(script);
    },
  });
};

export const deactivate: PluginModule["deactivate"] = () => {
  contextBridge.executeInMainWorld({
    func: function () {
      (
        window as unknown as {
          pluginManager?: { unregister(id: string): void };
        }
      ).pluginManager?.unregister("com.example.my-plugin");
    },
  });
};
```

`src/plugin-manager/ui.ts` (built to `assets/ui.cjs`):

```ts
import type { API } from "@open-orpheus/plugin-api/plugin-manager";

const manager = (window as unknown as { pluginManager: API }).pluginManager;
const id = "com.example.my-plugin";

// Safe to re-run when the script is injected again after a re-enable.
manager.unregister(id);
manager.register(id, {
  configuration: {
    mount(element) {
      element.textContent = "Settings";
      return () => {
        // Optional cleanup when the panel unmounts.
      };
    },
  },
});
```

Rules:

- `register` throws if that id is already registered. It never silently
  overwrites another contribution.
- `unregister` is idempotent. Call it from `deactivate()`.
- The host does not unregister for you. A plugin that forgets this leaves a
  stale panel and a visible lifecycle problem.
- `mount` may return an unmount callback. It runs when the registration is
  removed, the panel closes, or the component is replaced.
- Throw from `mount`/unmount only for genuine errors; the plugin manager shows
  them as plugin-manager realm diagnostics.
- Use the same plugin id as `metadata.json`; a mismatch is a bug even though the
  API cannot enforce it.

## Assets

Files under `assets/` are served through a custom protocol:

```text
assets://plugins/<plugin-id>/<path-inside-assets>
```

- `metadata.json`'s `icon` is relative to `assets/`, for example `"icon.png"`
  resolves to `assets/icon.png` and is displayed through that protocol.
- Asset paths are contained to `assets/`. Traversal and symlink escapes are
  rejected.
- Use assets URLs for icons, images, styles, and renderer scripts that need to
  run in the plugin manager's main world.

## Packaging and installation

A deployable plugin is either:

- a directory containing `metadata.json`, realm entries, and `assets/`, or
- an `.asar` archive of that directory.

User plugin directory:

- Development: `data/plugins/` relative to the working directory.
- Packaged: `{userData}/plugins/`.
- Override the data directory with `OPEN_ORPHEUS_CUSTOM_DATA_DIR`.

The plugin manager has no installer. Copy the tree into the plugin directory,
then restart the application — plugin discovery runs at startup. After that,
open the plugin manager and enable the plugin.

### Duplicate ids

Two user plugins with the same id are both rejected and shown as an unavailable
conflict in the plugin manager. Remove one and restart.

If a plugin reuses an id that a plugin shipped with the application already owns,
the shipped plugin keeps the id and the other copy is ignored with a warning.

## Debugging

- Activation and cleanup failures are logged in the main process log.
- The plugin manager shows the main-realm state, per-window secondary-realm
  instances, stage (`load`, `activate`, `deactivate`), and error messages.
- Disable the plugin system entirely with `OPEN_ORPHEUS_DISABLE_PLUGINS=1`.
- Preload plugins can log through `@preload/logger`, which forwards to the main
  logger.
- Check `metadata.json` first when a plugin is missing from the manager: a
  manifest error, a missing entry, or a duplicate id prevents loading.

## Testing

Plugin logic is easiest to test when `activate()` delegates to pure functions:

```ts
import { activate } from "./index";

const runtime = {
  registry: {
    load: async (key: string) => {
      if (key === "@main/logger") return { default: console };
      throw new Error(`unexpected key ${key}`);
    },
  },
} as unknown as Parameters<typeof activate>[0];

await activate(runtime);
```

Repository commands:

- `pnpm build:plugin-api` regenerates the local type package.
- Per-package: `pnpm --filter <package-name> build` / `check`.

## Compatibility

The plugin system is **experimental** and may break at any time between
releases. The type package is generated from the host and its version matches the
Open Orpheus release. The plugin surface intentionally exposes broad host
internals and does **not** promise API stability. A plugin may need updating
after any host release; the generated types are the source of truth.

## Cheat sheet

| Task                               | API                                                               |
| ---------------------------------- | ----------------------------------------------------------------- |
| Load a host module                 | `await runtime.registry.load("@main/...")`                        |
| Get another plugin's exports       | `await runtime.plugins.load(id)`                                  |
| Wait for another plugin's services | `await runtime.plugins.whenActive(id)`                            |
| Register settings UI               | `window.pluginManager.register(id, { configuration: { mount } })` |
| Remove settings UI                 | `window.pluginManager.unregister(id)`                             |
| Reference an asset                 | `assets://plugins/<id>/<path>`                                    |
| Disable the plugin system          | `OPEN_ORPHEUS_DISABLE_PLUGINS=1`                                  |

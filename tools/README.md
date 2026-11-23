# Build tooling

Everything build-time lives here; runtime code stays under `src/`, `gui/`,
`modules/`, and `packages/`.

## Layout

| Directory    | Duty                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forge/`     | Electron Forge glue: Vite plugins, custom makers, and packaging hooks. The root `forge.config.ts` / `vite.*.config.ts` stay at the project root and import from here.       |
| `packaging/` | Per-format packaging implementations (`deb`, `rpm`, `flatpak`, `appimage`), shared packaging helpers, and the templates/resources they render.                              |
| `config/`    | Frequently edited config data: plugin realms (`realms.ts`), packaging metadata (`packaging.ts`), and the Rust toolchain pin (`toolchain.ts`). Types live with their domain. |
| `registry/`  | Plugin realm interfaces (`realms.types.ts`) and the build-time registry scanner (`scan.ts`).                                                                                |
| `scripts/`   | Executable CLI entry points. Complex scripts keep their internals under `scripts/lib/<duty>/`.                                                                              |
| `shared/`    | Cross-cutting helpers: project paths, process spawning, CLI flags, and tsconfig alias reading.                                                                              |

## Common commands

```sh
pnpm build:modules                 # build native modules (modules/*)
pnpm build:plugins                 # build built-in plugin packages
pnpm make:deb / make:deb-src       # Debian binary / source package
pnpm make:rpm / make:srpm          # RPM / SRPM
pnpm build:plugin-api              # regenerate the plugin SDK types
```

Direct entry points:

- `node tools/scripts/build-scaffold.ts <out-dir> --name <name>` generates the
  `/usr` install layout (desktop entry, icons, symlinks).
- `node tools/scripts/build-flatpak-builder.ts` generates the Flathub manifest.
- `node tools/scripts/deploy-deps.ts [--restore]` swaps workspace modules for
  packed copies during packaging and restores them afterwards.
- `node tools/scripts/generate-changelog.ts --notes <file> --version <v>`
  updates the AppStream, Debian, and RPM changelogs.
- `node tools/scripts/icu-data.ts version|build ...` builds the filtered
  `icudtl.dat`.

If a script reports `ERR_MODULE_NOT_FOUND` for extensionless imports, run it
through the bundled resolver:

```sh
node --loader ./tools/scripts/dev/esm-loader.ts tools/scripts/<script>.ts ...
```

# Open Orpheus — Refactor & Plugin Roadmap

**Status:** design review draft. Nothing in this document is implemented yet.
**Revision:** 11 (2026-09-21) — P1-4 partially done: the main-window accessor is injectable and two
more own-module mocks are gone (11 → 7); the rest needs `window.ts` split first.
**Scope:** (a) cleanup of the current architecture, (b) a plugin system, built last.

This document is intentionally written so it can be **corrected between phases**. See
§0.2 for the amendment protocol.

---

## 0. How to read this document

### 0.1 Phasing contract

Every phase in §7 is independently:

- **reviewable** — it has objective exit criteria, not a vibe;
- **reversible** — it names a rollback;
- **correctable** — it names the assumptions that, if wrong, invalidate later phases.

A phase is only started once the previous phase's exit criteria pass. If a phase
reveals that a _later_ phase's design is wrong, the design is amended **before**
that later phase starts. Do not defer corrections to the end.

Phases P0–P3 are the cleanup. P4+ is the plugin system and is deliberately
underspecified — it will be redesigned once the cleanup lands, because the
cleanup is what creates its seams.

### 0.2 Amendment protocol

1. When evidence contradicts this document, edit **this document first**, in the
   same PR as the code change, and bump the revision number.
2. Record the contradiction in §10 (verification log) with the date and how it
   was established.
3. Mark superseded text with ~~strikethrough~~ rather than deleting it, for one
   revision, so reviewers can see what changed and why.
4. Never leave a phase's stated assumption and the observed reality in conflict.

### 0.3 Evidence standard

Claims in this document are tagged:

- **[V]** — verified by experiment or by reading the code/config. See §10.
- **[A]** — assumption or design proposal, not yet verified.
- **[?]** — open question, listed in §9.

### 0.4 Working rules (execution discipline)

These apply to every task in §7. They exist because the failure mode for a refactor
of this size is not a wrong decision — it is a decision that never gets recorded.

**R1 — Write the test when the module is complete and testable.**
A task is not finished until the module it changed is covered by a spec, written at
the point that module is complete and its behaviour is settled — not batched at the
end of a phase, and not deferred to a later "tests" phase.

- Specs mirror the source path and casing (`src/main/foo/Bar.ts` →
  `__test__/main/foo/Bar.spec.ts`).
- Prefer a substituted fake over `vi.mock` of our own modules. R1 and P1 pull in the
  same direction: the composition root is what makes substitution possible.
- The only sanctioned mocks are process boundaries — `electron`, `node:fs` via
  `__mocks__/fs/promises.cts`, `node:os`, `node:child_process`.
- If a module is genuinely untestable, record **why** in §10 rather than silently
  skipping it. `src/worklets/**` (decision 2026-09-15) is the existing precedent for
  an excluded area.

**R2 — Update `PLAN.md` when each task is finished.**
Mark the task's row in the §7 ledger `Done`, with the date, in the same commit or PR
that finishes it. If it was done differently than planned, say so in the Notes column
and amend the relevant section per §0.2. The ledger is the **only** tracking surface —
do not keep a parallel list elsewhere. A stale ledger is worse than a missing one,
because it makes the whole plan untrustworthy.

**R3 — One move or one service per commit; the app stays green at every commit.**
Every commit passes the Appendix B commands. Never batch a rename with a behaviour
change.

**R4 — A move is not finished until its non-import references are updated.**
Imports fail loudly; **comments, docs and CI filters do not**. The `plugins/` rename
alone has nine such references (§4.3). Use the per-move checklist in §5.3.

**R5 — Do not mix phases in one PR.** If a phase reveals work belonging to another
phase, add it to the ledger and continue.

**R6 — Amend the design in the same PR as the code that contradicts it** (§0.2).

**R7 — Strictness regressions are not allowed.** Once `strict` and a flag are enabled,
new code must satisfy them. Do not add per-line disables without a note in §10.

**R8 — Do not write comments that do not earn their place.** Code outlives the
conversation that produced it, so a comment aimed at that conversation is noise to
every later reader. Three banned categories:

- **Conversation/task context.** No dates, no phase or task IDs, no "as part of the
  refactor", no "measured on …", no references to this document or any decision log.
- **Pre-known restatement.** Anything already written in `PLAN.md`, `docs/`, or another
  file. Keep one source of truth, and it is the documentation — not the code.
- **Self-explaining code.** Section banners (`// Constants`, `// Utils`, `// Types`),
  and comments that narrate what the next line plainly does.

Acceptable: a non-obvious *why* — a workaround, a protocol or library quirk, an
upstream bug link, or a constraint the code cannot express. Test: if deleting the
comment loses nothing for a reader who never saw the conversation, delete it.

---

## 1. Objectives and non-goals

### 1.1 Objectives

1. **Make the object graph explicitly owned.** Initialization order stops being an
   emergent property of import order and becomes data.
2. **Make the graph constructible in a test.** Today the application graph cannot be
   booted under Vitest at all; integration is only reachable by launching Electron.
3. **Remove the need to mock our own modules in tests.**
4. **Fix the folder structure** where it actively misleads, and clear the name
   `plugins/` for the future runtime plugin system.
5. Only then: **build a plugin system** on the seams created above.

### 1.2 Success metrics

| Metric                            | Now                    | Target                          | Phase |
| --------------------------------- | ---------------------- | ------------------------------- | ----- |
| Own-module `vi.mock` sites        | 11 in 10 files **[V]** | 0                               | P1    |
| Specs importing via `../../src/…` | ~38 sites **[V]**      | 0                               | P0    |
| `$sharedTypes` declared in        | 4 places **[V]**       | 1–2                             | P0/P1 |
| `src/main.ts`                     | 486 lines **[V]**      | thin entry                      | P1    |
| `strict` in root `tsconfig.json`  | off **[V]**            | on — measured 0 errors          | P0    |
| Own-module `vi.mock` sites        | 11 in 10 files **[V]** | 0                               | P1    |
| App graph bootable in Vitest      | no                     | yes (via `createTestContext()`) | P1/P3 |

### 1.3 Non-goals

- **No DI container.** No inversify / tsyringe / awilix. Reasons in §5.0.
- No plugin sandboxing or capability _enforcement_ in v1 (declarations only, for
  audit and user warning).
- No plugin marketplace, signing, or update channel.
- No CJS or native-module plugins. ESM only — otherwise we inherit the ABI/rebuild
  pain already felt in `scripts/build-modules.ts`.
- Plugins extend; they never replace core services.
- No changes to the Rust modules in `modules/`.

---

## 2. Diagnosis

### 2.1 The three mechanisms behind "this is getting messy"

**(a) Initialization by import side effect.**
`src/main/calls/index.ts` is a barrel of `import "./app"; import "./audioeffect"; …`.
Handlers register as a consequence of importing, so load order is invisible,
unassertable, and untestable in isolation.

**(b) Mutable module singletons requiring a separate init call.**

- `src/main/settings.ts` exports `export let kv` / `export let events`, valid only
  after `initialize()` is called from `src/main.ts`. Import-before-init yields
  `undefined`, and the type says nothing.
- `src/main/window.ts` exports `export let mainWindow` plus `setMainWindow()`.
- `src/main/lifecycle.ts` exports `export let state`.

**(c) Ambient globals as the coupling mechanism.**
`dispatcher`, `lyricsDispatcher`, `playbackController`, `packManager`, `player`,
`kv`, `mainWindow` are reachable from anywhere without being declared as
dependencies. This is _why_ the graph is hard to hold in your head — not because
construction is manual.

**The irony worth naming:** `CallDispatcher` is already a service locator, and
`registerIpcHandlers` (`src/bridge/register.ts`) is already a contract-driven
registration system. The machinery exists. What's missing is an explicit owner.

### 2.2 The testability consequence

11 own-module `vi.mock` calls across 10 spec files **[V]**, mocking:
`src/main/{window, lyrics, settings, audio, cookie, mediaSession, database}` and
`src/bridge/preload`.

`src/main/window` alone is mocked by three separate specs
(`PlayCacheManager.spec.ts`, `PlayerCommandRouter.spec.ts`,
`bridge/common/inputRegion.spec.ts`). That repetition is the tell: `mainWindow` is
ambient, so every test that needs it hand-rolls a fake, three times, divergently.

These mocks exist **because dependencies are ambient**, not because the code is
complex. Once dependencies are parameters, a test passes a fake and the `vi.mock`
is deleted — the assertion survives, the mock does not. This is why repo memory
records that these sites "should disappear with the composition-root refactor, not
by rewriting the specs".

### 2.3 Structural problems

**[V] Two `windows/` directories with unrelated meanings.**

- `src/windows/*.ts` are **preload entry scripts** — built with
  `vite.preload.config.ts` per `forge.config.ts`'s build entries.
- `src/main/windows/*.ts` create `BrowserWindow`s.
- Meanwhile the main window's preload, `src/preload.ts`, lives somewhere else again.

Three placements, one concept.

**[V] `plugins/` at the repo root holds Vite _build_ plugins.**
(`ForceESPlugin.ts`, `LoggerPlugin.ts`, `MakerDeb.ts`, `MakerFlatpak.ts`,
`MakerRpm.ts`, `NoS3Plugin.ts`, `PinoWorkerPlugin.ts`.) This collides with the
runtime plugin system's name. Every
issue, PR, doc, and comment becomes ambiguous forever if it isn't renamed first.

**[V] `src/main/` is ~45 flat entries** with seven `foo.ts` + `foo/` pairs
(`calls`, `menu`, `cache`, `database`, `lyrics`, `audio`, `pack`/`packs`) and no
stated rule for which side is the facade.

**[V] Shared code at `src/` root** — `CallDispatcher.ts`, `util.ts`,
`constants.ts` are used by both main and preload, but sit beside the two entry
files.

**[V] Contracts in two places** — root `types/` (the `$sharedTypes` surface) and
`src/bridge/contracts/`.

---

## 3. Invariants

These are rules that must hold after every phase. They are the review checklist.

### 3.1 `CallDispatcher` is the web-pack ABI, not our internal bus

**Corrected 2026-09-21 by the repo owner.**

`CallDispatcher` exists so the proprietary Orpheus bundle's
`window.channel.call(cmd, cb, params)` can reach host implementations. It is
**not** how main / preload / utility-process communicate — that is `src/bridge/**`
(`registerIpcHandlers` + `$sharedTypes` contracts) and `MessageChannelMain` for
av3a.

Verified fallback chain **[V]**:

```
pack: window.channel.call(cmd, cb, params)
  → preload dispatcher (src/preload/calls.ts)
    → miss → ipcRenderer.invoke("channel.call", …)
      → main ipcMain.handle (src/main/channel.ts)
        → main dispatcher (src/main/calls.ts)
```

`dispatch()` returns `false` when no handler matches **[V]**; the renderer surfaces
this as "Unimplemented call command".

**Consequences:**

- Plugins must **never** register commands into it. The namespace belongs to the
  pack; adding to it pollutes an ABI we don't own and can collide with future NCAE
  commands.
- Plugins may only **intercept/modify** calls.
- Two _different_ dispatcher instances exist (main and preload), with different
  fallback semantics.

### 3.2 Registrar where the namespace is ours; interceptor where it's theirs

This single rule decides the shape of every extension point.

| Seam                                        | Namespace owner         | Shape              |
| ------------------------------------------- | ----------------------- | ------------------ |
| Call ABI (`dispatcher`)                     | the pack                | **interceptor**    |
| Bridge IPC (`ipc.handle("manage.…")`)       | us                      | registrar          |
| Settings keys, lifecycle events, menu items | us                      | registrar          |
| Pack responses (`orpheus://`)               | us, but contract-shaped | transform pipeline |

### 3.3 Every registration returns a `Disposable`

No exceptions. This one rule buys plugin teardown, dev hot-reload, and enforceable
leak tests. `src/bridge/common/settings.ts` already hand-rolls this pattern
(`wnd.on("closed", () => { unlistenChange(); unlistenDelete(); })`) — that is what
we are formalising.

### 3.4 Module resolution is owned by `tsconfig.json`

See §4.1. Aliases are declared **once**, in `tsconfig.json` `paths`.

---

## 4. Verified toolchain facts

### 4.1 TypeScript path aliases — Vite resolves them natively **[V]**

**Established by experiment, 2026-09-21.** A real `build()` of a virtual module at
`src/__probe__.ts` importing `$sharedTypes/ncae`:

| Case                                                 | Result       |
| ---------------------------------------------------- | ------------ |
| No `resolve.alias`, file under `src/`                | **RESOLVED** |
| No `resolve.alias`, bogus `$nope/whatever` (control) | FAILED       |
| Explicit `resolve.alias`                             | RESOLVED     |

The control proves the resolver is not accepting everything indiscriminately.

Vite 8 is rolldown-based (configs use `rolldownOptions`; the Forge patch references
"deprecated in Vite 8"), and rolldown's Oxc resolver reads tsconfig `paths`
natively. Vite 7 and earlier did **not**; there is no `vite-tsconfig-paths`
dependency, and the Forge Vite plugin's `getConfig`/`getBuildConfig` inject no
alias **[V, read from node_modules]**.

**The trap, and it matters for the folder cleanup:** `paths` resolves only for
files the tsconfig `include` covers. An earlier probe placed the virtual module at
the repo root — outside `include` — and failed. That failure is easy to
misdiagnose as "Vite doesn't support tsconfig paths".

> **Rule:** any new top-level directory must be added to `include` in the same
> commit, or aliases silently stop working in the bundler while `tsc` stays green.

Current `include`: `src`, `forge.env.d.ts`, `packaging/**/*.ts`, `scripts/*.ts`,
`types/*.ts`, `__test__/**/*.ts`. Paths are relative to the tsconfig (`./types/*`).

Toolchain matrix:

| Consumer                                 | Mechanism                                                      |
| ---------------------------------------- | -------------------------------------------------------------- |
| tsc / editor                             | `tsconfig.json` `paths`                                        |
| Vite (main, preload, worklets, renderer) | `tsconfig.json` `paths` (rolldown native)                      |
| eslint                                   | `eslint-import-resolver-typescript`, `typescript: true`        |
| GUI (SvelteKit)                          | `gui/svelte.config.ts` → `kit.alias`                           |
| Vitest                                   | explicit alias in `vitest.config.ts` — **required**, see below |

**Vitest does NOT read tsconfig `paths` — measured 2026-09-21 [V].** The bundler
and Vitest take different resolution paths, and only one of them is `paths`-aware:

| Path                                             | Reads `paths`? | How established                                                                                                                                                 |
| ------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite build()` / rolldown bundling (all targets) | **Yes**        | Virtual-module build probe (table above), then confirmed end-to-end by `pnpm package` succeeding with `@shared/*` in `src/main.ts` and `src/preload.ts` **[V]** |
| Vitest (dev-server / SSR module runner)          | **No**         | Removing the four aliases from `vitest.config.ts` makes `__test__/util.spec.ts` fail with `Cannot find package '@shared/util'` **[V]**                          |

Consequence: **`vitest.config.ts` must declare the same aliases as `tsconfig.json`
`paths`, and the two must not drift.** This supersedes the earlier guess that the
vitest alias was probably redundant. Two sources of truth need a guard — ledger task
P0-9.

`$sharedTypes` is declared in **4** places **[V]**: `tsconfig.json`,
`vite.main.config.ts`, `vitest.config.ts`, `gui/svelte.config.ts`. Of those, the
`vite.main.config.ts` entry is redundant (the bundler reads `paths`) while the
`vitest.config.ts` entry is **load-bearing**.

### 4.2 Strictness — `strict` is off, but enabling it is free **[V]**

`tsconfig.json` sets `noImplicitAny: true` and nothing else. `strictNullChecks` is
**off**, which means `X | undefined` collapses to `X`: the type system cannot
express "not yet initialized." §5.2 Rule 3 depends on this being fixed.

**Measurement (2026-09-21).** `tsc --noEmit -p tsconfig.json --strict` over a
1142-file program:

| Flag                                              | Errors                               | Verdict                                                |
| ------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `strict` (the umbrella, incl. `strictNullChecks`) | **0**                                | Enable now. One line. **[V]**                          |
| `noImplicitOverride`                              | **0** in `include`, **9** outside it | Needs P0-8 first. **[V]**                              |
| `noFallthroughCasesInSwitch`                      | **0**                                | Free. **[V]**                                          |
| `noPropertyAccessFromIndexSignature`              | 32                                   | Cheap, mechanical. **[V]**                             |
| `exactOptionalPropertyTypes`                      | 47                                   | Cheap-ish; needs care (unrelated to `strict`). **[V]** |
| `verbatimModuleSyntax`                            | 51                                   | Cheap, mechanical (`type`-only imports). **[V]**       |
| `noUncheckedIndexedAccess`                        | 264                                  | Real work. Not required by anything here. **[V]**      |

A control run with `--noUncheckedIndexedAccess` producing 264 errors confirms the
checker really is examining the program — the `strict` result is not a false pass.

**Files outside `include` are not type-checked at all [V].** `plugins/**/*.ts`,
`vite.*.config.ts` and `forge.config.ts` are absent from `tsconfig.json` `include`,
so `pnpm lint:types:root` never looks at them. Measured by re-running tsc with the
include extended to cover those 12 files:

- `strict` alone → **0 errors**, so "strict is free" holds project-wide and not
  merely for the included program.
- **`noImplicitOverride` → 9 errors**, every one `TS4114` in `plugins/MakerDeb.ts`,
  `plugins/MakerFlatpak.ts` and `plugins/MakerRpm.ts` (missing `override` on
  `prePack`/`postMake`). Not a P0 regression — those files have never been checked.
  Fix in P0-8, together with adding the paths to `include`, so R7 is enforceable on
  the build tooling too.

**The codebase is already `strict`-clean.** The earlier recommendation to scope
strictness to new code via a nested tsconfig (§9 Q4) is therefore
~~withdrawn~~ — enable `strict` project-wide instead. Other projects are already
strict: `gui/tsconfig.json` sets `"strict": true` **[V]**, and
`modules/lifecycle/tsconfig.json` extends `@tsconfig/node24` **[V]**.

`useUnknownInCatchVariables` stays off until `strict` lands; `toError(e)` already
handles the `any` catch binding and should be kept.

### 4.3 Other facts that constrain the work

- **Forge build entries** (`forge.config.ts`) list every bundled entry explicitly:
  `src/main.ts`, `src/preload.ts`, six `src/windows/*.ts`, four
  `src/worklets/*.ts`. **[V]** Any move must update this list.
- **Coverage scope** (`vitest.config.ts`): `include: ["src/**/*.ts",
"packaging/**/*.ts"]`, `exclude: ["src/{preload,worklets}/**/*.ts", …]`.
  `src/windows/**` is _included_ even though it is preload entry code — an
  inconsistency caused by the naming, not by intent. **[V]**
- **`LOGGER` is a compile-time global** injected by `plugins/LoggerPlugin.ts`, via
  the TypeScript compiler API. Declared in `src/main/logger.ts`. Modules using it
  need `installLoggerStub()` under Vitest. **[V]** Consequence for plugins: plugin
  code has no build step, so it will never have `LOGGER`. `ctx.logger` must be the
  only logging API plugins can reach.
- **Docs are parallel translations**: `CONTRIBUTING.md` and
  `docs/CONTRIBUTING_en.md` must be updated together. **[V]**
- **`__test__/**` mirrors `src` paths and casing**, and `tsconfig.json` `include`
  must keep the recursive `__test__/**/*.ts` glob (a non-recursive `*` breaks VS
  Code's inferred project). **[V]**
- **CI path filters** (`.github/workflows/changes.yml`): the `node` filter lists
  `src/**`, `types/**`, `__test__/**`, `gui/**`, `packaging/**/*.ts`,
  `scripts/**/*.ts`, the config files and `vite*.config.ts` — but **not
  `plugins/**`**. So a PR touching only `plugins/LoggerPlugin.ts` does not trigger
  the node job _today_. After the T1 rename the filter must gain the new path
  (`build/**`), or Vite-plugin changes become permanently invisible to CI. **[V]**
- **Preload bundle filenames are hardcoded in the main process** **[V]**.
  `src/main/windows/*.ts`, `src/main/menu/windows.ts` and
  `src/main/calls/winhelper.ts` reference `join(import.meta.dirname, "<name>.js")`.
  Forge's preload config emits `entryFileNames: "[name].js"`, so the emitted name is
  the **entry basename**. Moving `src/windows/` elsewhere is therefore safe _because
  the basenames do not change_ — but renaming an entry (`menu.ts` →
  `menu-preload.ts`) would require updating those call sites too. Check with
  `grep -rn 'join(import.meta.dirname, "' src/main`.
- **`plugins/` is named in prose in nine places** **[V]**: imports in
  `forge.config.ts`, `vite.main.config.ts`, `vite.preload.config.ts`; comments in
  `packaging/types.ts`, `packaging/flatpak/manifest.ts`,
  `scripts/build-flatpak-builder.ts`, `src/preload/logger.ts`,
  `__test__/helpers/globals.ts`; and the tree diagrams in `CONTRIBUTING.md` and
  `docs/CONTRIBUTING_en.md` (line ~69). Imports fail loudly — **the rest do not.**
- **Rust modules**: every crate is `crate-type = ["cdylib"]`, so `tests/*.rs`
  integration tests cannot link. Out of scope here, but do not expect to add
  integration tests on the Rust side accidentally.

---

## 5. Target architecture

### 5.0 Why no DI container

- **Multi-process.** Main, preload, renderer, workers, worklets. A container resolves
  within one realm; the real boundaries are IPC channels and `MessageChannelMain`,
  which no container abstracts.
- **No runtime type metadata.** tsyringe/inversify need
  `experimentalDecorators` + `emitDecoratorMetadata` + `reflect-metadata`. The build
  is Vite/esbuild-based; decorator metadata emit is weak or absent, and we'd fight
  the toolchain indefinitely.
- **It hides the graph from the bundler**, sacrificing deliberate dynamic
  `import()` startup optimisations (see the lazy imports in `src/main.ts`).
- **No multiple implementations to swap.** IoC pays off at 3+ impls of one
  interface; the single real case — `src/preload/backends/` — is already solved with
  a factory/strategy pattern. Do not generalise the app to serve one case.
- **Migration cost is front-loaded** across 200+ modules for no user-visible change,
  right before adding a plugin system to the same code.

What we want is _a composition root_, which is not a container: it is a function
that constructs the graph in a stated order and hands it out, typed.

### 5.1 Composition root

```
src/main/bootstrap/
  context.ts          bootstrap(deps): Promise<ReadyPhase>   (ordered async init)
  types.ts            Disposable, HostDeps, phase interfaces
  services/           createXService(deps) per service
  registrars.ts       the explicit ordered registration table
```

Design points:

- `bootstrap()` performs the ordered async work (open database → init settings →
  load pack → …) and resolves to a `ReadyPhase`. Callers can only obtain
  `ReadyPhase` from that promise, so **init order is encoded in the type** rather
  than in a comment at the top of `src/main.ts`.
- Services declare narrow dependency interfaces using `Pick<OtherService, "…">`.
  This keeps the **type** graph acyclic while the **runtime** graph may be cyclic
  (`settings` needs `database`, `database` needs `settings`).
- The `calls/index.ts` barrel becomes an explicit, ordered array typed with
  `satisfies`, making registration order _data_ rather than an import-graph
  accident.

#### Legacy accessor adapter (the migration trick)

To avoid a big-bang refactor, the old module-level exports stay, but they are
*installed by* the composition root rather than constructed in place:

```ts
// src/main/settings.ts
export let kv: Keyv;
export let events: Emittery<SettingsEvents>;

export function installSettingsService(service: SettingsService) {
  kv = service.kv;
  events = service.events;
}
```

~~The first draft suggested an exported getter (`export const get kv()`), which is not
expressible in ESM — you cannot export an accessor.~~ The install function gives the
same practical result: one writer (bootstrap), every existing call site byte-identical,
and the pre-existing undefined-before-init hazard is neither worsened nor hidden.

Files are converted one at a time. The adapter is deleted in the last phase of the
cleanup, and its deletion is the objective signal that the migration finished.

**What is scaffolding and what is permanent.** Worth keeping straight, because deleting
the wrong half would undo the migration:

| Scaffolding — delete later | Dies when |
|---|---|
| `export let kv` / `events`, `webDb` / `musicLibraryDb` / `nativeDb`, `mainWindow` | the last consumer takes the context instead of importing (P1-10) |
| `installSettingsService`, `installDatabaseService` | `bootstrap()` owns the services outright |
| `mainWindowAccessor`, `setMainWindow` as *module exports* | `src/main/window.ts` is split, so the root can own the reference; the accessor is then built by `bootstrap()` and the window service owns both read and write |
| `ReadyPhase.windows` being absent | same split |

| Permanent — the point of the migration | Why |
|---|---|
| `SettingsService`, `DatabaseService`, `MainWindowAccessor`, `RendererTarget` | a consumer declares what it needs rather than reaching for a global |
| Consumers taking them as parameters (`PlayerCommandRouter`, `PlayCacheManager`, …) | that *is* the explicit dependency; these parameters stay |

So the accessor is not the temporary part — the module-level binding behind it is.

### 5.2 Context typing

Five rules. Rule 3 (readiness as two value shapes) **requires `strictNullChecks`**,
which is why enabling `strict` is a P0 prerequisite — see §4.2.

**Rule 1 — derive, never declare.**

```ts
export function createContext(deps: HostDeps) { /* … */ return { … } as const; }
export type Context = ReturnType<typeof createContext>;
```

Naming convention, applied uniformly so it is reviewable at a glance:
`createX()` + `type XService = ReturnType<typeof createX>`. A hand-written
`interface Context` is the thing that rots.

**Rule 2 — break type cycles with `Pick`, not with `Context`.**

```ts
export interface SettingsDeps {
  database: Pick<DatabaseService, "nativeDb">;
  logger: Logger;
}
```

Also gives interface segregation for free: a service cannot reach for more than
the slice it was handed, because the slice _is_ its type.

**Rule 3 — encode readiness as two value shapes, not as `| undefined`.**

```ts
/** Available before any async work. */
export interface BootstrapPhase {
  logger: Logger;
  events: EventBus;
  folders: Folders;
}

/** Only obtainable after ordered init has run. */
export interface ReadyPhase extends BootstrapPhase {
  database: DatabaseService;
  settings: SettingsService;
  pack: PackService;
  windows: WindowService;
  ipc: IpcRegistry;
}

export function bootstrap(deps: HostDeps): Promise<ReadyPhase>;
```

Lazy accessors that throw ("used before bootstrap") are reserved for the §5.1
adapter only, never used as the primary design.

**Rule 4 — reuse the existing generics; invent no parallel vocabulary.**

- `HandlerFunction` / `CallbackHandlerFunction` (already exported from
  `src/CallDispatcher.ts`)
- `DeepIpcHandlers<T>` (already in `src/bridge/register.ts`)

The context _exposes_ these; it does not restate them. Notably,
`bridge.expose<Contract>(prefix, handlers: DeepIpcHandlers<Contract>)` gives a
plugin the same compile-time mirroring the GUI already gets through `getBridge()`
— extensibility becomes "publish a contract type, both sides are checked".

**Rule 5 — capability surfaces are `Pick`s, and the `Pick` list is the permission
surface.**

```ts
export type PluginContext = Pick<Context, "logger" | "settings" | "events"> & {
  id: string;
  register: {/* … */};
};
```

Reviewable as a diff, and it structurally prevents reaching internals that were
never handed over.

#### Call interception typing (per §3.1/§3.2)

Interception, **not** registration:

```ts
// src/CallDispatcher.ts (shared — preload has its own instance, so these types
// cannot live in src/main/**)

export interface CallFrame {
  readonly cmd: string;
  readonly side: "main" | "preload";
  args: unknown[]; // mutable: `before` may rewrite
}

export interface CallOutcome extends CallFrame {
  result: unknown[] | void; // mutable: `after` may rewrite
}

/** Let the call continue, or take it over. */
export type BeforeDecision = void | { handled: true; result: unknown[] };

export interface CallInterceptors<Side extends "main" | "preload" = "main"> {
  readonly side: Side;
  before(
    priority: number,
    hook: (call: CallFrame) => BeforeDecision | Promise<BeforeDecision>
  ): Disposable;
  after(
    priority: number,
    hook: (call: CallOutcome) => void | Promise<void>
  ): Disposable;
  /** Only invoked when no handler matched and dispatch would return false. */
  onUnhandled(
    priority: number,
    hook: (call: CallFrame) => unknown[] | void | Promise<unknown[] | void>
  ): Disposable;
}
```

Rationale for each shape decision:

- **No `register` member.** The API shape _is_ the policy (§3.2). A contributor
  cannot "just add a command" without editing the interface — the friction is the
  feature.
- **`{ handled: true; result }`** maps exactly onto `dispatch`'s existing
  `callback.call(undefined, ...(Array.isArray(result) ? result : []))`, so a
  short-circuit carries its result in one step.
- **`unknown[]` is the honest type.** There is no command→args table to derive from
  — commands are ad-hoc strings in `src/main/calls/*.ts`, and args are produced by
  unvalidated pack JavaScript at runtime. A hand-written table would be
  aspirational, not enforced, and would rot when NCAE adds a field. Hooks visibly
  narrow what they touch.
- **`priority` is required, not optional.** For interception, order is semantics: a
  `before` hook that rewrites args changes what later hooks observe, and for `after`
  the last writer wins. Being honest, requiring it buys _awareness_, not
  correctness — correctness comes from the deterministic tie-break (registration
  order, already fixed by the ordered registrar table). But a defaulted `priority`
  hides an observable decision behind an omitted argument.
- **Parameterised by `side`.** Main and preload have different fallback behaviour:
  preload's `onUnhandled` declining means "let the main process try"; main's means
  "let the renderer see `false`". Two behaviours, two types, no comment needed.
- **The ipc `event` is deliberately absent from `CallFrame`.** Main's handlers
  receive `IpcMainInvokeEvent` first, so surfacing it is tempting — but it hands
  over `sender`/`webContents`, i.e. arbitrary window control, as a side effect of
  intercepting. A plugin needing that asks the `windows` capability.

Capability granularity, for the eventual model:

| Member        | Power                                              |
| ------------- | -------------------------------------------------- |
| `before`      | rewrite args of any pack call — highest privilege  |
| `after`       | rewrite results the pack receives                  |
| `onUnhandled` | purely additive; cannot affect any working command |

Ship `onUnhandled` first; it is the least privileged and the safest.

### 5.3 Folder structure

Target:

```
src/
  main.ts, preload.ts          # entries, and they get thin
  shared/                      # process-agnostic: CallDispatcher.ts, util.ts, constants.ts
  main/
    bootstrap/                 # composition root
    services/                  # stateful + injectable: settings, database, cache, window, pack, tray
    domain/                    # pure logic: lyrics, skin, playback, id3, ncae, afp, crypto
    platform/                  # OS/app integration: protocol, request, cookie, device, fonts, shortcuts
    ipc/                       # was calls/ — handlers + explicit registration array
    windows/                   # BrowserWindow definitions (meaning unchanged)
  preload/
    …existing runtime…
    entries/                   # was src/windows/
  bridge/
```

`packaging/` and `scripts/` stay as-is.

#### Alias naming

`@types/*` is **forbidden** as an internal alias. It is DefinitelyTyped's published
scope, and it is the same prefix TypeScript resolves through `node_modules/@types/**`
and `compilerOptions.types` (e.g. `vite/client` today). Available namespaces:
`@shared`, `@main`, `@preload`, `@bridge`.

#### Sequencing rule (the important trick)

**Add aliases first, migrate imports, then move files.** After step 1 and 2, moving
a file is a pure rename with **zero import churn**, and specs stop depending on
their own directory depth. Doing it in the other order means every move churns
every importer.

#### Tiers

| Tier   | Scope                                                                                                                                      | Risk        | Recommendation              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------- |
| **T1** | Root `plugins/` → `build-plugins/`; `src/windows/` → `src/preload/entries/`; `src/{CallDispatcher,util,constants}.ts` → `src/shared/` | Low         | Do it (P0)                  |
| **T2** | Group `src/main/*` per §5.3; unify the `foo.ts`+`foo/` facade rule; consolidate root `types/` vs `src/bridge/contracts/`                   | Medium      | P2, after aliases           |
| **T3** | Fold `src/main/playback/adapters/` alongside `modules/{nowplaying,smtc,dbus}`; rename `pack.ts`/`packs/`; split `src/main.ts`              | Opinionated | Defer; P1 handles the split |

#### Per-move checklist

Easy to forget one:

- [ ] `forge.config.ts` build entries (the build breaks loudly if missed)
- [ ] `vitest.config.ts` coverage include/exclude
- [ ] `tsconfig.json` `include` (and `paths` if a new top-level dir appears)
- [ ] `eslint.config.ts`
- [ ] `.github/workflows/changes.yml` `node` path filters (silent if missed)
- [ ] mirror paths under `__test__/**` — both the imports _and_ the directory names
- [ ] `CONTRIBUTING.md` **and** `docs/CONTRIBUTING_en.md` (tree diagram line ~69,
      preload notes line ~113)
- [ ] packaging file lists (deb / rpm / flatpak)
- [ ] **grep the repo for the old path in comments** — `packaging/types.ts`,
      `packaging/flatpak/manifest.ts`, `scripts/build-flatpak-builder.ts`,
      `src/preload/logger.ts`, `__test__/helpers/globals.ts` all name
      `plugins/LoggerPlugin.ts` or `plugins/Maker*.ts` in prose. **[V]**
- [ ] **check the moved files' own imports** — a move changes their directory depth, so
      relative specifiers that escape the new directory must be re-edged or aliased.
      Grep the moved directory for `"../` and verify each resolves. **This bit twice**
      (P0-5, then P0-4) because external references were checked but the moved files
      themselves were not. **[V]**

---

## 6. Test strategy

### 6.1 Design rules applied during the cleanup

1. **Dependencies as parameters.** Substitute; don't mock our own modules.
2. **`registerX(ctx)` / `interceptX(...)` returning a `Disposable`**, never import
   side effects.
3. **Pure core, impure shell.** The existing 20 mock-free specs are the model; keep
   new code on that side of the line.
4. **Process boundaries behind thin injectable seams** (`fs`, `clock`, `electron`,
   `net`) — declared explicitly in `HostDeps`, not via `DeepPartial`.
5. **The composition root is the integration-test seam.** `createContext({
overrides })` lets a test boot the whole graph with memfs + a fake Electron.
6. **Registration order is data**, so tests can assert exact order.
7. **Symmetric lifecycle** — teardown leaves no listeners; assert it. This catches
   leak classes currently invisible.

### 6.2 Seams to add

- `HostDeps` (explicit optional seams: `fs?`, `clock?`, `electron?`).
- `__test__/helpers/context.ts` exporting `createTestContext()`, later reused by
  the plugin host's specs.

Chosen over `DeepPartial<Context>` because, with `strictNullChecks` off, a
`DeepPartial` types essentially nothing (§4.2).

### 6.3 Test ownership

Follow the existing convention: a spec owns _semantics_, and wrappers get a
one-line contract test rather than re-testing semantics through an extra layer.
Interceptor specs belong beside `CallDispatcher.spec.ts`, since interception is a
dispatcher concept — not in a bootstrap spec.

Worth pinning once `onUnhandled` exists: the currently-untested unhandled-command
path (renderer's "Unimplemented call command"), assertable as `onUnhandled`
returning `void` vs a result array.

### 6.4 Known pitfalls when running the suite

Recorded so a phase's first test run is not spent rediscovering them.

- **`LOGGER` is a compile-time global.** Any main-process module that logs needs
  `installLoggerStub()` from `__test__/helpers/globals.ts` before its handlers run, or
  the bare `LOGGER` reference throws `ReferenceError`.
- **memfs starts empty.** `vol.mkdirSync(dir, { recursive: true })` before `mkdtemp`;
  use absolute fixture paths (relative ones anchor at `process.cwd()` and leak the
  checkout path into snapshots); never snapshot the whole volume.
- **Explicit factory mocks** are required for `node:fs` (as opposed to
  `node:fs/promises`), `node:child_process`, `node:os` and `electron`. Only
  `node:fs/promises` can use the factoryless `vi.mock` that redirects to
  `__mocks__/fs/promises.cts`.
- **Emittery v2** listeners receive `{ name, data }` and run in a microtask — flush
  with `await new Promise((r) => setTimeout(r, 0))` before asserting order.
- **IPC call handlers receive the ipc event as their first argument**, so tests must
  pass a placeholder event to `dispatcher.dispatch`.
- **Always `await` `.resolves` / `.rejects`** — Vitest warns today and will fail in
  the next major.
- **`describe.runIf(...)` cannot be aliased to a variable** — call it inline, or the
  suite silently registers nothing.
- **Do not write specs for `src/worklets/**`** (decision 2026-09-15): that code runs
  in the renderer's AudioWorklet, which Vitest cannot execute faithfully.

---

## 7. Phased plan

Phases P0–P3 are the cleanup. P4+ is the plugin system.

### 7.0 Task ledger

**This is the tracking surface** (R2). Update the row in the same commit that
finishes the task. Detail for each task is in the phase section referenced below.

| ID    | Task                                                                                 | Phase | Status      | Done       | Notes                                                                                          |
| ----- | ------------------------------------------------------------------------------------ | ----- | ----------- | ---------- | ---------------------------------------------------------------------------------------------- |
| P0-1  | Enable `strict` + `noImplicitOverride` + `noFallthroughCasesInSwitch`                | P0    | **Done**    | 2026-09-21 | 0 errors, as measured (§4.2)                                                                   |
| P0-2  | Add `@shared`/`@main`/`@preload`/`@bridge` to `tsconfig.json` `paths`                | P0    | **Done**    | 2026-09-21 | Plus mirrored aliases in `vitest.config.ts` — required, see §4.1                               |
| P0-3  | Rewrite relative `src` imports to aliases                                            | P0    | **Done**    | 2026-09-21 | 0 remaining — the last 7 went with P0-5                                                            |
| P0-4  | Move `plugins/` → `build-plugins/`                                              | P0    | **Done**    | 2026-09-21 | 18 refs: 8 imports, `tsconfig.json` include, 7 prose, 2 docs; plus the Makers' own relative imports                                                                |
| P0-5  | Move `src/windows/` → `src/preload/entries/`                                         | P0    | **Done**    | 2026-09-21 | 6 forge entries, 2 specs, 2 docs; specs moved to `__test__/preload/entries/`; bundles keep basenames                                    |
| P0-6  | Move `src/{CallDispatcher,util,constants}.ts` → `src/shared/`                        | P0    | **Done**    | 2026-09-21 | `git mv` used, history preserved                                                               |
| P0-7  | Add `build/**` to `changes.yml` `node` filters                                       | P0    | **Done**    | 2026-09-21 | `build/**` added to the `node` filter — this was a pre-existing gap                                                                               |
| P0-8  | Add `plugins/**`, `vite.*.config.ts`, `forge.config.ts` to `include`; fix 9 `TS4114` | P0    | **Done**    | 2026-09-21 | 9 `override` modifiers added; `eslint.config.ts` still unchecked                               |
| P0-9  | Guard test: vitest aliases mirror `tsconfig.json` `paths`                            | P0    | **Done**    | 2026-09-21 | `__test__/aliases.spec.ts`; falsified by deleting an alias (failed as expected); also rejects vacuous passes                                          |
| P0-10 | Ignore generated dirs in eslint (`coverage/**`)                                      | P0    | **Done**    | 2026-09-21 | `coverage/**` ignored in `eslint.config.ts` and `.prettierignore`; `pnpm lint:eslint` now emits nothing at all |
| P0-11 | Sweep pre-existing offensive comments | P0 | **Done** | 2026-09-21 | Applied R8's tight reading: 14 pure-narration comments deleted. ~30 short label/banner candidates deliberately left — several carry a real *why*, which is a judgement call, not a mechanical one. `#region`/`#endregion` are folding markers, out of scope |
| P1-1  | Bootstrap skeleton + phase types (`BootstrapPhase`/`ReadyPhase`)                     | P1    | **Done**    | 2026-09-21 | `src/main/bootstrap/{types,context}.ts`; `bootstrap(deps)` returns a `ReadyPhase`             |
| P1-2  | Settings service + legacy install adapter                                            | P1    | **Done**    | 2026-09-21 | `createSettingsService` + `installSettingsService`; all 8 `kv`/`events` call sites unchanged; 2 own-module mocks dropped |
| P1-3  | Database service                                                                     | P1    | **Done**    | 2026-09-21 | `createDatabaseService` owns the schema + PRAGMAs; `openDatabase` is the test seam             |
| P1-4  | De-globalise `mainWindow` (`src/main/window.ts`)                                     | P1    | **Partial** | 2026-09-21 | Accessor injected into `PlayerCommandRouter` + `PlayCacheManager`; the 3 specs that mocked `@main/window` are down to 1 (`inputRegion`, which needs `ManagedWindow`, a different export). Still importing the global: `winhelper`, `tray`, `MediaEngine`, `Av3aEngine`, `main.ts` — see §10 |
| P1-5  | De-globalise lifecycle `state`                                                       | P1    | Not started |            |                                                                                                |
| P1-6  | Explicit registrar table replacing `calls/index.ts` barrel                           | P1    | Not started |            | order becomes data                                                                             |
| P1-7  | Reduce `src/main.ts` to a linear entry                                               | P1    | Not started |            | 486 → thin                                                                                     |
| P1-8  | Integration smoke test booting the graph                                             | P1    | **Done**    | 2026-09-21 | `__test__/main/bootstrap/context.spec.ts` boots `bootstrap()` with fake deps and asserts the adapters are installed. Grows as services land |
| P1-9  | Delete own-module `vi.mock` sites                                                    | P1    | Not started |            | 11 → 0 (§1.2)                                                                                  |
| P1-10 | Delete the legacy adapter                                                            | P1    | Not started |            | signals migration end                                                                          |
| P2-1  | Group `src/main/*` per §5.3                                                          | P2    | Not started |            | high churn — schedule                                                                          |
| P2-2  | Decide/document the `foo.ts` + `foo/` rule                                           | P2    | Not started |            | likely "document" (§9.1)                                                                       |
| P2-4  | Fold `types/` → `src/shared/types/`; retire `$sharedTypes` | P2 | Not started | | Decision 2026-09-21: one alias namespace (`@shared/types/*`) instead of `$sharedTypes` + `@shared`. Do with P2-3. Requires: `gui/svelte.config.ts`, `vitest.config.ts` (+ coverage exclude, or declaration-only files enter the denominator), `vite.main.config.ts`; ~40 import sites; `types/**` entry in the CI `node` filter becomes dead |
| P2-3  | Consolidate root `types/` vs `src/bridge/contracts/`                                 | P2    | Not started |            |                                                                                                |
| P3-1  | `createTestContext()` helper                                                         | P3    | Not started |            |                                                                                                |
| P3-2  | ~~Resolve `$sharedTypes` duplication~~ — superseded by P2-4                                                   | P3    | Not started |            | verify before deleting (Q9)                                                                    |
| P3-3  | Coverage scope for `src/preload/entries/**` (moot after P0-5 — now excluded like its siblings)                                          | P3    | Not started |            |                                                                                                |
| P3-4  | Mid-cost strictness flags (130 errors total)                                         | P3    | Not started |            | §4.2                                                                                           |
| P3-5  | Preload `new Function` spike                                                         | P3    | Not started |            | unblocks P4 (§9.2)                                                                             |

---

### P0 — Aliases and T1 moves

**Goal.** Establish alias infrastructure and fix the two misleads that cost the
most reader confusion, with no behaviour change.

**Execution order (corrected 2026-09-21).** Ledger IDs stay stable, but this order is
_not_ the numeric order. `@shared/*` cannot be declared before `src/shared/` exists,
and moving files before aliases would rewrite their imports twice.

1. **P0-1** — strict flags.
2. **P0-6 together with P0-2** — create `src/shared/`, add all four aliases to
   `paths`, and repoint the `src/{util,CallDispatcher,constants}.ts` importers
   straight at `@shared/*`. One pass, no intermediate relative-path state.
   `@main`/`@preload`/`@bridge` land in the same edit — their directories already
   exist.
3. **P0-3** — rewrite the remaining `../../src/**` specifiers (mostly `__test__/**`).
4. **P0-8** — add the missing `include` paths and fix the 9 `TS4114` errors.
5. **P0-4**, **P0-5** — the two directory moves. Rename-only from the import side;
   the actual work is the non-import references (R4).
6. **P0-7** — CI filters.

**Changes.**

0. **Enable `strict` (and `noImplicitOverride`, `noFallthroughCasesInSwitch`) in
   `tsconfig.json`.** Measured at 0 errors (§4.2) — a one-line change with no code
   churn, and a prerequisite for P1's typing. Land it first so everything after is
   checked under it.
1. Add top-level aliases to `tsconfig.json` `paths` only (see §4.1):
   `@shared`, `@main`, `@preload`, `@bridge` (decided: `@`, §9 Q1).
2. Mechanically rewrite `../../src/...` imports across `src/**` and `__test__/**`.
   No file moves in the same commit.
3. Move root `plugins/` → `build-plugins/`; update `forge.config.ts`,
   `eslint.config.ts`, and any imports.
4. Move `src/windows/` → `src/preload/entries/`; update the six build entries in
   `forge.config.ts` and mirror `__test__/windows/*` paths.
5. Move `src/{CallDispatcher.ts,util.ts,constants.ts}` → `src/shared/`.
6. While touching `util.ts`: **do not** rename it (`src/main/util.ts` also exists —
   see §9 Q2).

**Exit criteria.**

- Zero `../../src/` imports in `src/**` and `__test__/**`.
- `pnpm lint:types` and `pnpm test` green.
- `pnpm exec electron-forge package` succeeds (proves the build-entry list is
  correct — _this is the real gate_, since a stale entry fails only at build).
- No file in the repo refers to `plugins/` meaning Vite plugins without the new
  path.

**Gate status (2026-09-21).** Verified for the alias foundation: types, tests and
`pnpm package` all pass. **Dev mode (`pnpm start`) has not been exercised.** The
reasoning that it is safe: forge's `serve` mode still bundles main/preload through
rolldown (`watch: {}`), which reads `paths`; the renderer is SvelteKit, which uses its
own `$lib`/`$bridge` aliases and imports none of the new ones. That is **[A]**, not
verified — and Vitest proves a non-bundler resolution path _can_ differ (§4.1), so
treat dev mode as unproven until someone runs it.

**P0 status: complete (2026-09-21).** P0-1…P0-11 are all done. Residual: dev mode was
verified by the repo owner *before* P0-4/P0-5 changed the build entries, so `pnpm start`
has not been exercised against the current entry list. `pnpm package` covers the same
entry resolution but not the dev server/watch path. Re-run `pnpm start` before starting P1.

**Risk.** Low. Mechanical. The only real hazard is a partially-updated build-entry
list, which the package step catches.

**Review checkpoint.** If the alias prefix choice proves awkward after step 1–2 (or
rolldown turns out not to honour `paths` in one target after all), stop and amend
§4.1 before moving any file. Everything after this phase depends on the alias
mechanism being sound.

**Rollback.** `git revert`; each numbered change is an independent commit.

---

### P1 — Composition root

**Goal.** Explicit ownership of the graph; delete the ambient singletons; make the
graph constructible in a test.

**Changes.**

1. Add `src/main/bootstrap/{context.ts,types.ts,services/*}` with
   `bootstrap(deps): Promise<ReadyPhase>` (§5.2 Rule 3).
2. Convert `src/main/settings.ts` from `export let kv` + `initialize()` to a service
   factory, with a legacy `get kv()` adapter (§5.1).
3. De-globalise `mainWindow` (`src/main/window.ts`) and `state`
   (`src/main/lifecycle.ts`) via the adapter.
4. Replace the `src/main/calls/index.ts` barrel with the explicit ordered registrar
   table typed `satisfies`.
5. Reduce `src/main.ts` to: parse argv → `bootstrap(deps)` → create windows.

**Exit criteria.**

- Own-module `vi.mock` sites: **11 → 0**. This is the metric that proves the
  refactor addressed the actual problem.
- `bootstrap()` runs under Vitest with `fs` (memfs) and `electron` fakes injected —
  i.e. an integration smoke test exists and passes.
- `src/main.ts` contains no sequencing loops or multi-step init chains; it reads
  linearly.
- `grep` finds no `export let` service without a context owner.

**Risk.** Medium. This is the substantive change. Ordering mistakes surface as
startup breakage, not type errors — which is precisely why §5.2 Rule 3 puts
ordering in the type.

**Review checkpoint.** The most likely thing to invalidate later phases. If
`ReadyPhase` turns out to need a third phase, or `Pick`-based deps prove too
awkward for a highly-connected service (e.g. `pack`), **amend §5.2 before P2** —
P2's folder moves assume the service boundaries are settled.

**Rollback.** The adapter makes this incremental: converting one module at a time
means the phase can be paused at any file with the app still working.

---

### P2 — T2 folder structure

**Goal.** Make `src/main/` navigable; settle the facade convention.

**Changes.** Group `src/main/*` per §5.3; unify `foo.ts` + `foo/` into
`foo/index.ts` + `foo/*.ts` (or document the current rule — see §9 Q2); decide
root `types/` vs `src/bridge/contracts/`.

**Exit criteria.** No behaviour change; `pnpm test` + `lint:types` + `package` green;
`src/main/` has no directory with >15 direct entries.

**Risk.** High churn, low technical risk. **It touches every file under
`src/main/`, so it will conflict with any in-flight branch** — schedule
accordingly.

**Review checkpoint.** If the `foo.ts` + `foo/` rule cannot be unified without
moving barrels that other code imports by exact path, stop and document the
existing rule instead. The goal is _legibility_, not symmetry.

**Rollback.** Renames only; `git revert` is clean.

---

### P3 — Test infrastructure

**Goal.** Lock in the gains, remove remaining friction.

**Changes.**

1. `__test__/helpers/context.ts` → `createTestContext()`.
2. Resolve the remaining alias duplication (§4.1): `vite.main.config.ts`'s
   `$sharedTypes` is redundant and can go. The `vitest.config.ts` aliases are
   **load-bearing** and stay (Q9), guarded by P0-9.
3. Decide coverage scope for `src/preload/entries/**` (its siblings under
   `src/preload/**` are excluded today; the current split is an artefact of the old
   naming).
4. Remaining strictness flags on the measured-cost basis in §4.2.

**Exit criteria.** Every phase's metrics in §1.2 met; the cleanup's own exit report
written into §10.

**Review checkpoint.** This is the boundary before the plugin system. Do not begin
P4 until the alias mechanism, `ReadyPhase`, and the `Disposable` convention have
each been _exercised_ by P0–P3 rather than merely designed.

---

### P4+ — Plugin system (deferred)

**Do not design these in detail yet.** The cleanup creates the seams; the seams may
change. Only the invariants in §3 and the shapes in §8 are decided.

| Phase | Content                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------- |
| P4    | Manifest + discovery + ordering + `activate(ctx)` + `Disposable`s + `--no-plugins`. Main plane only. |
| P5    | Pack transform pipeline (§8.2). Needs cache-invalidation semantics settled first.                    |
| P6    | Preload plane (§8.3). Needs the delivery spike (§9 Q3) resolved first.                               |
| P7    | Declarative pack rules + JSON-Schema settings UI in the `manage` window.                             |
| P8    | Hardening: permission audit, `--safe-mode`, docs, `@open-orpheus/plugin-api` types package.          |

---

## 8. Deferred: plugin system design sketch

Kept for review, but explicitly not frozen — see the amendment protocol (§0.2).

### 8.1 Plane model

| Plane       | Runs in                            | Privilege                         | Can modify renderer?                      |
| ----------- | ---------------------------------- | --------------------------------- | ----------------------------------------- |
| **Main**    | Electron main, `import()`ed ESM    | Full (superset)                   | Indirectly, via the others                |
| **Preload** | Sandboxed isolated world, pre-page | No FS, no Node, has `ipcRenderer` | Yes — prototype patches, IPC interception |
| **Pack**    | Host-owned response pipeline       | None (data only)                  | Yes — HTML/JS/CSS/assets                  |

One manifest, three planes: `id`, `version`, `apiVersion` (int major), `engines`,
`entry.main`, `entry.preload` (keyed by window target), `pack` (declarative rules),
`permissions` (audit only in v1), `dependencies`, `loadBefore`/`loadAfter`.

Design decision to argue about: **pack patching should not require code.**
Declarative rules (`append` / `prepend` / `injectBefore` / `replace`) cover most UI
hacks, are inspectable in a settings UI, and cannot brick the app by throwing.
Imperative `transform()` remains available to main-plane plugins.

### 8.2 Pack pipeline

Ordered middleware over the response shape `{ content, contentType, cacheable }`
produced by `loadFromOrpheusUrl` / `loadFromFilePath` (`src/main/orpheus.ts`).

Three rules that prevent bugs otherwise shipped:

1. **Cache interaction — narrower than first drafted.** Caching is already an
   external stack (`got` → `cacheable-request` → `Keyv` → SQLite), with
   `HttpCacheStorage` (`src/main/cache/HttpCacheStorage.ts`) as the storage adapter
   and `client` (`src/main/request.ts:89`) as the got instance **[V]**. It is used
   only where `cache: cacheStorage` is passed explicitly — i.e. the
   `orpheus://cache?<url>` handler (`src/main/orpheus.ts:342`) **[V]**.
   **Pack file reads do not touch it at all**: `orpheus://orpheus/<path>` goes to
   `loadFromFilePath` → `Pack.readFile`, straight out of the pack archive.
   So for the primary use case — patching UI files in the web pack — cache
   invalidation is **a non-issue**. Where a plugin does transform a network-backed
   response, the rule is simply: **transform after the cache read and never write
   transformed bytes back.** Transforms are a read-time view, not a cache mutation;
   no plugin-set key hashing is needed. (This supersedes the earlier
   `cacheable: false` / cache-key proposal.)
2. **Virtual files.** A plugin must be able to serve a path absent from the pack, so
   patched HTML can reference `orpheus://orpheus/plugins/foo.css` instead of inline
   blobs.
3. **`versions.json` gating is untouched.** The commit-hash check in `src/main.ts`
   runs before patches apply, so a plugin can never confuse "pack is up to date".

### 8.3 Preload plane — the constraint

**[V]** There is no `sandbox: false` anywhere in `src/main/**`, and nothing under
`src/preload/**` imports a `node:` builtin. So preload is sandboxed and **cannot
read its own plugin files**; main must deliver the fragments.

- **Option A (recommended):** preload calls
  `ipcRenderer.invoke("plugins.preloadFragments", target)` before page load; main
  returns `[{ id, code }]`; preload evaluates each in try/catch and reports errors
  back. No rebuild, works inside asar, per-window targeting.
  _Caveat under-weighted earlier:_ if fragments are runtime strings, **TypeScript
  cannot type-check them.** Plugin authors must compile with their own tsconfig and
  ship the `ctx` `.d.ts` alongside.
- **Option B (fallback):** a Vite plugin concatenates fragments into the preload
  bundle at build time. Zero runtime magic, no runtime install.

Either way, preload plugins share one isolated world per window — specify a
namespacing convention and add a collision detector for prototype patches.

### 8.4 Ops

- Flags: `--no-plugins`, `--safe-mode` (disable pack patches only),
  `--plugin-dir=<path>`, mirroring the existing `--redownload-package` style.
- **`--safe-mode` is not optional**: a pack patch can brick the UI before any UI
  exists to disable it.
- Failing plugin → disabled for the session, logged via pino, surfaced in the
  `manage` window. Pack stage errors fail _open_ (serve original content) unless the
  plugin opts into strict mode. Timeouts on async stages.

---

## 9. Open questions and decisions needed

| #      | Question                                                                                                     | Blocks | Recommendation                                                                                                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1** | Alias prefix?                                                                                                | P0     | **DECIDED: `@`.** `@shared`, `@main`, `@preload`, `@bridge`. Caveat noted: `@x/y` is a valid npm scope, so an _unbundled_ runtime `import("@main/x")` would resolve as a package and fail confusingly; irrelevant for bundled code, but the plugin loader must resolve its own paths rather than rely on aliases. |
| **Q2** | Unify `foo.ts` + `foo/`?                                                                                     | P2     | **Downgraded — probably document, not move.** With `@` aliases, `@main/menu` vs `@main/menu/...` is unambiguous, so the naming inconsistency costs far less than a repo-wide rename. See the clarification in §9.1.                                                                                               |
| **Q3** | Is `new Function` permitted in the sandboxed preload world?                                                  | P4/P6  | Determines whether the **preload plane can exist at runtime at all**. See §9.2.                                                                                                                                                                                                                                   |
| **Q4** | **ANSWERED.** `strict` project-wide is free (0 errors); reviewer agrees to raise it.                         | P0     | Enable `strict` + the two free flags globally. Remaining flags decided on the measured costs in §4.2.                                                                                                                                                                                                             |
| **Q5** | **ANSWERED.** Caching is `got`/`cacheable-request`/Keyv; `HttpCacheStorage` is only the adapter.             | —      | §8.2 rule 1 narrowed: pack reads never touch the HTTP cache.                                                                                                                                                                                                                                                      |
| **Q6** | Which callers reach `Pack.readFile` directly, bypassing the pipeline?                                        | P5     | Each is a hole in the transform pipeline.                                                                                                                                                                                                                                                                         |
| **Q7** | Does adding schemes from plugins require a relaunch (`registerSchemesAsPrivileged` must run before `ready`)? | P8     | Determines whether pre-ready discovery must be synchronous.                                                                                                                                                                                                                                                       |
| **Q8** | macOS notarisation / library validation and Flatpak sandboxing vs loading code from `userData`?              | P8     | Check `packaging/flatpak/manifest.ts` and the hardened-runtime config.                                                                                                                                                                                                                                            |
| **Q9** | **ANSWERED.** Is the `vitest.config.ts` alias redundant?                                                     | —      | **No — required.** Vitest does not read tsconfig `paths` (§4.1), so it needs its own aliases. Keep them; P0-9 guards the mirror.                                                                                                                                                                                  |

### 9.1 Q2 clarification — what "unify `foo.ts` + `foo/`" was asking

`src/main/` contains seven cases where a file and a directory share a prefix, and
the relationship between them is **not consistent**, so a reader cannot tell which
kind they are looking at:

| Pair                        | Relationship                                                                    |
| --------------------------- | ------------------------------------------------------------------------------- |
| `menu.ts` + `menu/`         | file is the public facade (`AppMenu`), dir is implementation                    |
| `calls.ts` + `calls/`       | file is registration wrappers, dir is the handlers                              |
| `audio.ts` + `audio/`       | file is protocol/codec glue, dir is engine classes                              |
| `cache.ts` + `cache/`       | file is module init (`httpCacheStorage`), dir is the classes — **not** a facade |
| `lyrics.ts` + `lyrics/`     | mixed                                                                           |
| `database.ts` + `database/` | mixed                                                                           |
| `pack.ts` + `packs/`        | **singular file, plural dir** — looks unrelated but isn't                       |
| — + `skin/`                 | directory with **no** facade file at all                                        |

The question was whether to standardise on `foo/index.ts` as the facade plus
`foo/*.ts` as implementation, which makes the pattern self-describing.

**Recommendation: document, don't move.** With `@` aliases (Q1), a reader sees
`@main/menu` versus `@main/menu/types` and the ambiguity largely evaporates —
`import { patchById } from "@main/menu/types"` is self-evidently not the facade.
Against that, unifying is a rename across the highest-churn phase, so the
cost/benefit has flipped since the first draft. Write the rule into
`CONTRIBUTING.md` **and** `docs/CONTRIBUTING_en.md` instead.

The `util.ts` collision (`src/util.ts` and `src/main/util.ts`) is likewise defused
by aliases — `@shared/util` versus `@main/util`. No rename needed.

### 9.2 Q3 clarification — what `new Function` in preload affects

It decides **whether the preload plane can exist as a runtime-installable thing**,
so it reaches further than one API call.

The chain: preload is sandboxed (§8.3) and has no filesystem access, so main must
deliver plugin code to the preload **as a string**. Something must then evaluate
that string in the preload's isolated world — `new Function(src)`, indirect
`eval`, or `vm` (unavailable under sandbox). `contextBridge.executeInMainWorld`
does not remove the need: it requires a real function object, which the string
still has to become first.

**If it is blocked:**

1. Option A (runtime delivery) is dead → Option B (build-time concatenation) is
   mandatory.
2. Preload-plane plugins **cannot be installed by dropping a folder** — a rebuild
   is required. Fine for first-party plugins, disqualifying for third-party ones.
3. Disabling one becomes a runtime guard inside already-bundled code, not the
   absence of code. **A "disabled" preload plugin still ships and still executes.**
   That is a different trust story, because you can no longer verify inertness by
   inspecting the bundle.
4. The preload plugin API should then be **declarative** — a constrained set of
   operations declared in the manifest (wrap a `contextBridge` exposure, patch a
   named global, add an IPC listener) and interpreted by host code — rather than
   arbitrary code.
5. Silver lining: build-time means TypeScript _can_ check fragments, which runtime
   strings never allow.

**If it is allowed:** Option A is viable, and the manifest can carry real
`entry.preload` code paths.

**How to settle it:** a ~20-line spike — a preload that attempts
`new Function("return 1")()` and `eval("1")`, then reports both results over IPC.
Cheap and decisive.

**When:** end of P3, not P6. The answer changes the manifest's _shape_
(declarative patch operations versus a code entry point), and the manifest is P4
material — so resolving it after P4 starts means redesigning P4.

---

## 10. Verification log

| Date       | Claim                                                                                                                                                                                                                       | How established                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-21 | Vite 8 resolves tsconfig `paths` with no `resolve.alias` **[V]**                                                                                                                                                            | Real `build()` of a virtual module at `src/__probe__.ts` importing `$sharedTypes/ncae`: RESOLVED. Control `$nope/whatever`: FAILED. Explicit alias: RESOLVED.                                                                            |
| 2026-09-21 | `paths` only apply to files covered by tsconfig `include` **[V]**                                                                                                                                                           | Same probe with the virtual module at repo root (outside `include`) FAILED, then RESOLVED once moved under `src/`.                                                                                                                       |
| 2026-09-21 | Forge Vite plugin injects no alias **[V]**                                                                                                                                                                                  | Read `node_modules/@electron-forge/plugin-vite/dist/{ViteConfig.js,config/vite.*.config.js,vite.base.config.js}`; `getConfig` merges base + target + userConfig only.                                                                    |
| 2026-09-21 | `strict` is off **[V]**                                                                                                                                                                                                     | Read `tsconfig.json` compilerOptions in full: only `noImplicitAny: true`.                                                                                                                                                                |
| 2026-09-21 | Enabling `strict` costs **0 errors** across 1142 files **[V]**                                                                                                                                                              | `tsc --noEmit -p tsconfig.json --strict`, exit 0, empty output; `--showConfig` confirms `"strict": true` applied. Control `--noUncheckedIndexedAccess` → 264 errors, proving the program was genuinely checked.                          |
| 2026-09-21 | Non-strict flag costs: `exactOptionalPropertyTypes` 47, `noPropertyAccessFromIndexSignature` 32, `verbatimModuleSyntax` 51, `noUncheckedIndexedAccess` 264; `noImplicitOverride` and `noFallthroughCasesInSwitch` 0 **[V]** | One `tsc --strict --<flag>` run per flag, error lines counted.                                                                                                                                                                           |
| 2026-09-21 | HTTP caching is external; pack reads bypass it **[V]**                                                                                                                                                                      | Read `src/main/cache/HttpCacheStorage.ts`, `src/main/cache.ts`, `src/main/request.ts:89`, and `cache: cacheStorage` at `src/main/orpheus.ts:342`.                                                                                        |
| 2026-09-21 | 11 own-module `vi.mock` sites in 10 spec files **[V]**                                                                                                                                                                      | `grep` for `vi.mock("…/src/…")` across `__test__/**`.                                                                                                                                                                                    |
| 2026-09-21 | Side-effect init + mutable singletons **[V]**                                                                                                                                                                               | Read `src/main/calls/index.ts`, `src/main/settings.ts`, `src/main/window.ts`, `src/main/lifecycle.ts`, `src/main.ts`.                                                                                                                    |
| 2026-09-21 | Call ABI fallback chain; `dispatch` → `false` when unhandled **[V]**                                                                                                                                                        | Read `src/preload/channel.ts`, `src/main/channel.ts`, `src/CallDispatcher.ts`.                                                                                                                                                           |
| 2026-09-21 | `src/windows/*.ts` are preload entries **[V]**                                                                                                                                                                              | `forge.config.ts` build entries pair them with `vite.preload.config.ts`.                                                                                                                                                                 |
| —          | `CallDispatcher` is the pack ABI, not an internal bus **[V]**                                                                                                                                                               | Stated by the repo owner, 2026-09-21. Led to §3.1/§3.2.                                                                                                                                                                                  |
| 2026-09-21 | **Vitest does NOT read tsconfig `paths` [V]**                                                                                                                                                                               | Removed the four aliases from `vitest.config.ts` via a probe config and ran `__test__/util.spec.ts`: `Cannot find package '@shared/util'`. Restored. This **corrects** the earlier guess in §4.1/Q9 that the vitest alias was redundant. |
| 2026-09-21 | Bundler targets do read `paths`, end to end **[V]**                                                                                                                                                                         | `pnpm package` succeeded with `@shared/*` used from `src/main.ts` and `src/preload.ts` — main, preload, worklets and renderer all bundled.                                                                                               |
| 2026-09-21 | P0 foundation: types + tests green **[V]**                                                                                                                                                                                  | `pnpm lint:types` → 0 errors (tsc + svelte-check). `pnpm test` → 53 files, 489 tests passed.                                                                                                                                             |
| 2026-09-21 | P0-5 move verified end to end **[V]** | `pnpm lint:types` 0 errors; `pnpm test` 53 files / 489 tests; `pnpm package` succeeded and `.vite/build` still contains `menu.js`, `manage.js`, `mini-player.js`, `desktop-lyrics.js`, `desktop-lyrics-preview.js`, `package-download.js`, so main's hardcoded `join(import.meta.dirname, "<name>.js")` still resolves. |
| 2026-09-21 | P1-4 partial — and the rest is not free **[V]** | Added `RendererTarget` + `MainWindowAccessor` (`bootstrap/types.ts`) and a `mainWindowAccessor` export on `window.ts`. Injected as a constructor arg into `PlayerCommandRouter` (3rd) and `PlayCacheManager` (2nd), wired from `mediaSession.ts` and `calls/storage.ts`; `createCacheManager(windows)` takes it rather than importing `window.ts`, which would have dragged electron into `cache.ts`'s importers (`MediaEngine`, `Av3aEngine`). **Remaining**: `winhelper`, `tray`, `MediaEngine`, `Av3aEngine`, `main.ts`. Converting those needs `window.ts` split first — it imports electron, `./menu` and the native `@open-orpheus/window` at module scope, so `bootstrap()` cannot own the accessor without pulling all three into every test. That split is also the prerequisite for §5.2's `ReadyPhase.windows`, so that field stays deferred. |
| 2026-09-21 | P1-1/P1-2/P1-3: composition root lands **[V]** | `src/main/bootstrap/{types,context}.ts` + `services/{database,settings}.ts`. `bootstrap(deps)` returns a `ReadyPhase`, and `src/main.ts` calls it where `initializeDatabases()` + `initialize()` used to be. `pnpm test` 56 files / 499 tests, `pnpm lint` clean, `pnpm package` succeeded. |
| 2026-09-21 | §5.1's accessor sketch was not expressible **[V]** | `export const get kv()` is invalid TypeScript — ESM cannot export an accessor. Replaced with an install function (see §5.1). |
| 2026-09-21 | Relocate code verbatim, do not paraphrase **[V]** | While moving `getMany` into the settings service I rewrote its body (`KV_ENTRIES[keys[i]]` read twice instead of hoisted into `defaultValue`). Behaviourally equivalent, but a move should be a move. Caught because the source file then failed to match on the next edit; corrected to the original form. |
| 2026-09-21 | `folders.ts` needs electron at import time **[V]** | It calls `app.getPath` and `app.isPackaged` at module scope, so any spec that reaches it must mock `electron` with at least `{ app: { getPath, isPackaged } }`. This is why the composition root takes `logger` explicitly: `src/main/logger.ts` opens log files and imports electron, so defaulting it would have made `context.ts` unloadable in tests. |
| 2026-09-21 | P0-10: `coverage/` was missing from both ignore lists **[V]** | `eslint.config.ts` ignored `.vite/**` and `out/**` but not `coverage/**`, and `.prettierignore` had no coverage entry either — so `pnpm format` would also descend into generated files. Both added; `pnpm lint:eslint` now prints nothing. |
| 2026-09-21 | P0-11 sweep boundary **[V]** | Of 1037 standalone comments, the strict task/date/PR pattern found **zero** real violations — all 4 hits are legitimate (a log-format example, a JSDoc explaining a filename choice, an upstream PR link, which R8 explicitly allows). 14 pure-narration comments deleted. ~30 short label candidates (`// Constants`, `// Flag files`, `// Window might be destroyed`) were left on purpose: several carry a genuine *why*, so purging them is a judgement call rather than a mechanical rule. `#region`/`#endregion` are IDE folding markers and are out of scope. |
| 2026-09-21 | `build/vite-plugins/` renamed to `build-plugins/` **[V]** | Removes the `build/` vs `.vite/build/` vs `out/` triple meaning. The Makers' own imports needed re-edging again (`../../packaging/` → `../packaging/`) — the checklist step added after P0-4 applied immediately. `pnpm lint:types` 0 errors, `pnpm test` 492 passed, `pnpm package` succeeded. |
| 2026-09-21 | P0-9 guard test can actually fail **[V]** | Deleted `@bridge` from `vitest.config.ts` and ran `__test__/aliases.spec.ts`: `AssertionError: vitest.config.ts has no alias for @bridge/*`. Restored. It also asserts both alias sets are non-empty, so a JSON import shape change cannot make it pass vacuously. |
| 2026-09-21 | P0-4 rename verified end to end **[V]** | `pnpm lint:types` 0 errors, `pnpm test` 489 passed, `pnpm lint:eslint` 0 errors, `pnpm package` succeeded (the packaging step is what loads the Makers). `.gitignore` has `build/Release`, not `build/`, so `build/vite-plugins/` is not ignored. |
| 2026-09-21 | Moving a directory breaks the moved files' own relatives **[V]** | The Makers' `../packaging/*` imports resolved to `build/packaging/*` after the rename; 14 specifiers needed a depth fix. Surfaced as `TS2307` plus `import/no-unresolved`, with one consequential `TS7006` that disappeared once the imports resolved. Caught by `pnpm lint:types`, **not** by `pnpm test` — the Makers are only exercised at package time. |
| 2026-09-21 | Earlier P0-3 verification was wrong **[V]** | The pattern `from "…"` missed bare side-effect imports and dynamic `import("…")`, so 7 specifiers went unreported. Corrected pattern: `"\.\./(\.\./)*src/`, now 0 matches. |
| 2026-09-21 | `strict` is 0 errors outside `include` too **[V]**                                                                                                                                                                          | Extended-`include` probe over the 12 uncovered files (`plugins/**`, `vite.*.config.ts`, `forge.config.ts`): 0 errors with `strict`; **9** with `noImplicitOverride` (all `TS4114` in `plugins/Maker*.ts`).                               |

---

## Appendix A — Change summary vs. the initial draft

Corrections made during review, kept visible per §0.2:

1. **Plugin system moved from Phase 1 to last.** Only the composition root survives
   into near-term scope. The earlier "extract the pack pipeline early" recommendation
   is retracted: its only consumer was the plugin system.
2. **`CallDispatcher` is not a registrar** (§3.1). It is the web-pack ABI. Plugins
   intercept; they never register commands. This invalidated the first
   `CallRegistrar` typing sketch and moved the interceptor types out of
   `src/main/bootstrap/` into the dispatcher module (§5.2).
3. **Adding an alias is a 1-line `tsconfig.json` change**, not five coordinated
   config edits (§4.1). The earlier migration checklist was too pessimistic.
4. **Folder structure was not in the original plan at all** (§5.3) — added at the
   reviewer's request.
5. **Testability framing corrected**: own-module mocks are a _symptom of ambient
   dependencies_, so the refactor deletes the need for them rather than rewriting
   the specs (§2.2, §6).
6. **`strict` measured as free** (§4.2). The earlier proposal to scope strictness
   to `src/main/bootstrap/**` via a nested tsconfig is withdrawn — the whole
   project is already `strict`-clean, so it becomes a P0 one-liner instead of a P3
   project.
7. **Cache concern narrowed** (§8.2). Caching is an external library stack and pack
   file reads never touch it, so the cache-invalidation design was solving a
   problem that does not exist for the primary use case.
8. **Working rules added** (§0.4) at the reviewer's request: test-at-completion and
   ledger-at-completion, plus the move-hygiene rules R3–R7. A task ledger (§7.0),
   known pitfalls (§6.4) and a verification cheat sheet (Appendix B) were added so
   the plan is self-sufficient for someone picking it up cold.

---

## Appendix B — Verification cheat sheet

Run from the repo root. These are the R3 gate: green before every commit, mandatory
at every phase boundary.

| Purpose                     | Command                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ |
| Unit/integration tests      | `pnpm test`                                                                          |
| A single spec               | `pnpm vitest run __test__/main/util.spec.ts`                                         |
| Types — root project        | `pnpm lint:types:root`                                                               |
| Types — GUI                 | `pnpm lint:types:gui`                                                                |
| Types — both                | `pnpm lint:types`                                                                    |
| Lint                        | `pnpm lint:eslint`                                                                   |
| Lint + types (what CI runs) | `pnpm lint`                                                                          |
| Format                      | `pnpm format`                                                                        |
| Coverage                    | `pnpm coverage` — writes `coverage/coverage-final.json`; a non-coverage run wipes it |
| **Package the app**         | `pnpm package` (`electron-forge package`)                                            |
| Full local run              | `pnpm start`                                                                         |
| Build the Rust modules      | `pnpm build:modules`                                                                 |

Notes:

- **`pnpm package` is the only check that catches a stale `forge.config.ts` build
  entry.** `pnpm lint:types` will not: a moved preload entry still type-checks fine
  while the packaging step silently bundles nothing. Treat it as the mandatory gate
  for P0 and P2.
- `pnpm start` requires the Rust modules to be built. If it fails at native-module
  import, run `pnpm build:modules` first — on Linux that needs `cargo-zigbuild` + `zig`,
  with versions pinned in `packaging/common/toolchain.ts`. **[A]**
- Rust-side checks (`cargo test --workspace`, clippy, fmt) are unaffected by this plan
  but still gate CI. Do not break them by touching `modules/**`.
- `tsconfig.json` `include` must keep `__test__/**/*.ts`; a bare `__test__/*.ts`
  silently matches only top-level files, leaving nested specs to VS Code's inferred
  project (which has no `paths`, so `$sharedTypes` degrades to `any`).

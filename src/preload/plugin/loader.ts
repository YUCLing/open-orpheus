import type { PluginDesiredState } from "@shared/contracts/plugin-manager-api";
import {
  LifecycleFailureStage,
  LifecycleStateKind,
  RealmLifecycle,
  type LifecycleSnapshot,
} from "@shared/plugin/lifecycle";
import {
  createPluginRegistry,
  type MutablePluginRegistry,
  type PluginRegistrySource,
  type Registry,
} from "@shared/plugin/registry";
import { toError } from "@shared/util";

import type { PluginModule, PluginRuntime } from "@shared/plugin/realms/preload/index";

/** Only Electron is available to an evaluated preload bundle. */
export type PreloadRequire = (id: string) => unknown;

const unavailableRequire: PreloadRequire = (id) => {
  throw new Error(`No preload require is available for "${id}"`);
};

export function evaluatePreloadModule(
  source: string,
  id: string,
  requireModule: PreloadRequire = unavailableRequire
): unknown {
  const module = { exports: {} as Record<string, unknown> };
  // Preload plugins are trusted CJS bundles evaluated in the preload context;
  // this is the loader, not an eval of renderer-controlled input.
  // oxlint-disable-next-line typescript/no-implied-eval
  const factory = new Function(
    "module",
    "exports",
    "require",
    `${source}\n//# sourceURL=open-orpheus-plugin://${id}/preload.cjs`
  ) as (
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
    require: PreloadRequire
  ) => void;

  factory(module, module.exports, requireModule);
  return module.exports;
}

export interface PreloadPluginLoaderOptions {
  /** Plugin id → CJS bundle source. */
  sources: ReadonlyMap<string, string>;
  registry: Registry;
  /** Injectable for tests. Defaults to evaluating the source in this context. */
  evaluate?: (source: string, id: string) => unknown;
  /** Injectable for tests; defaults to the restricted Electron-only require. */
  requireModule?: PreloadRequire;
  /** Report per-plugin lifecycle snapshots back to the main process. */
  onStatus?: (id: string, snapshot: LifecycleSnapshot<PluginModule>) => void;
  /** Soft per-plugin activation and cleanup deadline. */
  activationTimeoutMs?: number;
}

export enum PreloadPluginStatus {
  Pending = "pending",
  Active = "active",
  Failed = "failed",
}

export interface PreloadPluginRecord {
  id: string;
  lifecycle: RealmLifecycle<PluginModule>;
  readonly status: PreloadPluginStatus;
  readonly module: PluginModule | undefined;
  readonly error: unknown;
  readonly snapshot: LifecycleSnapshot<PluginModule>;
}

/**
 * Evaluates and activates preload-realm plugin bundles.
 *
 * The bundle is evaluated in the host preload context, so it can use the
 * sandboxed `electron` require and the host's `contextBridge`/`ipcRenderer`.
 * One `RealmLifecycle` per plugin owns desired state, activation, timeout,
 * cleanup and status reporting.
 */
export class PreloadPluginLoader {
  private readonly records: PreloadPluginRecord[] = [];
  private readonly recordsById = new Map<string, PreloadPluginRecord>();
  private readonly runtimeBase: { registry: Registry };
  private readonly pluginRegistry: MutablePluginRegistry;
  private readonly evaluate: (source: string, id: string) => unknown;
  private readonly sourceProviders = new Map<string, () => Promise<string | null>>();
  private readonly registrySourceMap = new Map<string, PluginRegistrySource>();
  /** One evaluation per module epoch, shared by lifecycle and dependency loads. */
  private readonly moduleCache = new Map<string, Promise<PluginModule>>();
  /** Records whose late-settling operation must finish before removal. */
  private readonly pendingRemovals = new Set<string>();
  private readonly onStatus?: (id: string, snapshot: LifecycleSnapshot<PluginModule>) => void;
  private readonly activationTimeoutMs?: number;

  constructor(options: PreloadPluginLoaderOptions) {
    this.evaluate =
      options.evaluate ??
      ((source: string, id: string) =>
        evaluatePreloadModule(source, id, options.requireModule ?? unavailableRequire));
    this.onStatus = options.onStatus;
    this.activationTimeoutMs = options.activationTimeoutMs;

    for (const [id, source] of options.sources) {
      this.registerSource(id, async () => source);
    }

    this.pluginRegistry = createPluginRegistry(this.registrySourceMap);
    this.runtimeBase = { registry: options.registry };
  }

  get plugins(): ReadonlyArray<PreloadPluginRecord> {
    return this.records;
  }

  has(id: string): boolean {
    return this.recordsById.has(id);
  }

  /**
   * Register all sources without activating. Call before `activateAll` so a
   * plugin can load another enabled plugin's exports during activation.
   */
  registerAll(sources: ReadonlyMap<string, string>): void {
    for (const [id, source] of sources) {
      this.registerSource(id, async () => source);
    }
  }

  /** Apply desired state to every already-registered plugin. */
  enableAll(revision = 0): void {
    for (const record of this.records) {
      record.lifecycle.applyDesiredState({ enabled: true, revision });
    }
  }

  waitForAll(): Promise<void> {
    return Promise.all(this.records.map((record) => this.waitForDecision(record))).then(() => {});
  }

  async activateAll(revision = 0): Promise<void> {
    this.enableAll(revision);
    await this.waitForAll();
  }

  /** Apply a committed desired state to one plugin. */
  applyDesiredState(id: string, desired: PluginDesiredState): void {
    const record = this.recordsById.get(id);
    if (!record) return;
    if (desired.enabled) this.pendingRemovals.delete(id);
    record.lifecycle.applyDesiredState(desired);
  }

  /** Evaluate and activate one plugin; used for tests and live enables. */
  add(id: string, source: string): Promise<void> {
    this.pendingRemovals.delete(id);
    this.pluginRegistry.forget(id);
    this.moduleCache.delete(id);
    this.registerSource(id, async () => source);
    return this.enableRecord(id, { enabled: true, revision: 1 });
  }

  /** Fetch and activate one plugin. Source fetch is inside its lifecycle. */
  enable(
    id: string,
    getSource: () => Promise<string | null>,
    desired: PluginDesiredState = { enabled: true, revision: 1 }
  ): Promise<void> {
    this.pendingRemovals.delete(id);
    this.pluginRegistry.forget(id);
    this.moduleCache.delete(id);
    this.registerSource(id, getSource);
    return this.enableRecord(id, desired);
  }

  /**
   * Register a source and apply desired state without waiting for activation.
   * Used to publish every pending enable before any plugin can depend on it.
   */
  start(id: string, getSource: () => Promise<string | null>, desired: PluginDesiredState): void {
    this.pendingRemovals.delete(id);
    this.pluginRegistry.forget(id);
    this.moduleCache.delete(id);
    this.registerSource(id, getSource);
    this.recordsById.get(id)?.lifecycle.applyDesiredState(desired);
  }

  /** Retry one plugin's failed lifecycle, if it is still enabled. */
  retry(id: string): void {
    const record = this.recordsById.get(id);
    if (!record || !record.lifecycle.desiredState.enabled) return;
    this.pluginRegistry.forget(id);
    record.lifecycle.retry();
  }

  /** Deactivate and forget one plugin; used for live disables. */
  async remove(
    id: string,
    desired: PluginDesiredState = { enabled: false, revision: 1 }
  ): Promise<void> {
    const record = this.recordsById.get(id);
    if (!record) return;

    // Drop the exports cache now. A re-enable can return early below, but the
    // new instance must never be shadowed by the old module.
    this.pluginRegistry.forget(id);
    this.moduleCache.delete(id);
    record.lifecycle.applyDesiredState(desired);
    await this.waitForSettled(record);

    // A re-enable may have happened while cleanup was running. The latest
    // intent wins; do not delete the record/source/loader it now owns.
    const latest = record.lifecycle.snapshot;
    if (latest.desired.enabled || latest.module) return;

    if (latest.state.kind === LifecycleStateKind.Stopped) {
      this.dropRecord(id);
      return;
    }

    // A hung load or cleanup is still running. Removing the record now would
    // let a re-enable create a second instance while the old operation is
    // still alive; wait until it actually settles.
    if (latest.state.kind === LifecycleStateKind.Hung) {
      this.pendingRemovals.add(id);
    }
  }

  async deactivateAll(): Promise<void> {
    const records = [...this.records].reverse();
    await Promise.all(
      records.map(async (record) => {
        this.pluginRegistry.forget(record.id);
        this.moduleCache.delete(record.id);
        try {
          const result = await record.lifecycle.dispose(2000);
          if (result.status !== "stopped") {
            LOGGER.warn(
              { pluginId: record.id, status: result.status },
              "Preload plugin shutdown cleanup did not complete cleanly"
            );
          }
        } catch (error) {
          LOGGER.error(
            { pluginId: record.id, err: toError(error) },
            "Preload plugin shutdown cleanup failed"
          );
        }
      })
    );
  }

  private runtimeFor(id: string): PluginRuntime {
    return { registry: this.runtimeBase.registry, plugins: this.pluginRegistry.forPlugin(id) };
  }

  private loadPluginModule(id: string): Promise<PluginModule> {
    const record = this.recordsById.get(id);
    if (!record) return Promise.reject(new Error(`Unknown plugin "${id}"`));
    if (!record.lifecycle.desiredState.enabled) {
      return Promise.reject(new Error(`Plugin "${id}" is not enabled`));
    }

    // The lifecycle and cross-plugin `load()` share this evaluation. Without
    // it, activation and dependency reads execute the CJS source twice and
    // produce two different module instances.
    const cached = this.moduleCache.get(id);
    if (cached) return cached;

    const pending = (async () => {
      const provider = this.sourceProviders.get(id);
      if (!provider) throw new Error(`Plugin "${id}" has no source`);
      const source = await provider();
      if (source === null) throw new Error(`Plugin "${id}" source is unavailable`);
      return toPluginModule(this.evaluate(source, id), id);
    })();

    this.moduleCache.set(id, pending);
    void pending.catch(() => {
      if (this.moduleCache.get(id) === pending) this.moduleCache.delete(id);
    });
    return pending;
  }

  private dropRecord(id: string): void {
    const record = this.recordsById.get(id);
    if (!record) return;

    const index = this.records.indexOf(record);
    if (index !== -1) this.records.splice(index, 1);
    this.recordsById.delete(id);
    this.sourceProviders.delete(id);
    this.registrySourceMap.delete(id);
    this.moduleCache.delete(id);
    this.pendingRemovals.delete(id);
    this.pluginRegistry.forget(id);
  }

  /**
   * Shared by lifecycle activation and `runtime.plugins.load()`.
   *
   * Prefer the module the lifecycle is actually using. The evaluation cache
   * avoids a second CJS execution before that module exists, but the lifecycle
   * instance is authoritative: re-enable, retry and cleanup transitions must
   * never make a dependency observe a different object than the active plugin.
   * Only whether the caller waits for activation differs (`whenActive`).
   */
  private ensureModule(id: string): Promise<PluginModule> {
    const record = this.recordsById.get(id);
    if (!record) return Promise.reject(new Error(`Unknown plugin "${id}"`));
    if (!record.lifecycle.desiredState.enabled) {
      return Promise.reject(new Error(`Plugin "${id}" is not enabled`));
    }

    // Only the running attempt is authoritative. During cleanup the lifecycle
    // still holds the old module, but a re-enable has already opened a new
    // evaluation epoch; handing out the old instance there would leak it.
    const snapshot = record.lifecycle.snapshot;
    if (snapshot.state.kind === LifecycleStateKind.Running && snapshot.module) {
      return Promise.resolve(snapshot.module);
    }

    return this.loadPluginModule(id);
  }

  private async whenActive(id: string): Promise<PluginModule> {
    const record = this.recordsById.get(id);
    if (!record) throw new Error(`Unknown plugin "${id}"`);
    if (!record.lifecycle.desiredState.enabled) {
      throw new Error(`Plugin "${id}" is not enabled`);
    }
    const snapshot = await record.lifecycle.waitFor(
      (current) =>
        current.state.kind === LifecycleStateKind.Running ||
        current.state.kind === LifecycleStateKind.Failed ||
        current.state.kind === LifecycleStateKind.Hung ||
        current.state.kind === LifecycleStateKind.Abandoned ||
        !current.desired.enabled
    );
    if (snapshot.state.kind !== LifecycleStateKind.Running || !snapshot.module) {
      throw new Error(`Plugin "${id}" is not active`);
    }
    return snapshot.module;
  }

  private enableRecord(id: string, desired: PluginDesiredState): Promise<void> {
    const record = this.recordsById.get(id);
    if (!record) return Promise.reject(new Error(`Unknown plugin "${id}"`));
    record.lifecycle.applyDesiredState(desired);
    return this.waitForDecision(record);
  }

  private registerSource(id: string, provider: () => Promise<string | null>): void {
    this.sourceProviders.set(id, provider);
    if (this.recordsById.has(id)) return;

    const lifecycle = new RealmLifecycle<PluginModule>({
      timeoutMs: this.activationTimeoutMs,
      adapter: {
        load: () => this.ensureModule(id),
        activate: (module) => module.activate(this.runtimeFor(id)),
        deactivate: (module) => module.deactivate?.(),
      },
      onChange: (snapshot) => {
        if (
          snapshot.state.kind === LifecycleStateKind.Failed &&
          snapshot.state.stage !== LifecycleFailureStage.Deactivate
        ) {
          LOGGER.error(
            { pluginId: id, err: toError(snapshot.state.error) },
            "Preload plugin activation failed"
          );
        }
        this.onStatus?.(id, snapshot);

        if (
          snapshot.state.kind === LifecycleStateKind.Stopped &&
          !snapshot.desired.enabled &&
          this.pendingRemovals.delete(id)
        ) {
          this.dropRecord(id);
        }
      },
    });

    const record: PreloadPluginRecord = {
      id,
      lifecycle,
      get status() {
        return toPreloadStatus(lifecycle);
      },
      get module() {
        return lifecycle.loadedModule;
      },
      get error() {
        return lifecycle.snapshot.error;
      },
      get snapshot() {
        return lifecycle.snapshot;
      },
    };
    this.records.push(record);
    this.recordsById.set(id, record);
    this.registrySourceMap.set(id, {
      load: () => this.ensureModule(id),
      whenActive: () => this.whenActive(id),
    });
  }

  private async waitForDecision(record: PreloadPluginRecord): Promise<void> {
    await record.lifecycle.waitFor(
      (snapshot) =>
        snapshot.state.kind === LifecycleStateKind.Running ||
        snapshot.state.kind === LifecycleStateKind.Failed ||
        snapshot.state.kind === LifecycleStateKind.Hung ||
        snapshot.state.kind === LifecycleStateKind.Abandoned ||
        (snapshot.state.kind === LifecycleStateKind.Stopped && !snapshot.desired.enabled)
    );
  }

  private async waitForSettled(record: PreloadPluginRecord): Promise<void> {
    await record.lifecycle.waitFor(
      (snapshot) =>
        snapshot.state.kind === LifecycleStateKind.Stopped ||
        snapshot.state.kind === LifecycleStateKind.Failed ||
        snapshot.state.kind === LifecycleStateKind.Hung ||
        snapshot.state.kind === LifecycleStateKind.Abandoned ||
        snapshot.state.kind === LifecycleStateKind.Disposed
    );
  }
}

function toPreloadStatus(lifecycle: RealmLifecycle<PluginModule>): PreloadPluginStatus {
  const snapshot = lifecycle.snapshot;
  switch (snapshot.state.kind) {
    case LifecycleStateKind.Running:
      return PreloadPluginStatus.Active;
    case LifecycleStateKind.Failed:
    case LifecycleStateKind.Hung:
    case LifecycleStateKind.Abandoned:
      return PreloadPluginStatus.Failed;
    default:
      return PreloadPluginStatus.Pending;
  }
}

function toPluginModule(imported: unknown, id: string): PluginModule {
  if (imported === null || typeof imported !== "object") {
    throw new Error(`Plugin ${id} did not export a preload module object`);
  }
  const candidate = imported as Partial<PluginModule>;
  if (typeof candidate.activate !== "function") {
    throw new Error(`Plugin ${id} does not export an activate() function in its preload realm`);
  }
  if (candidate.deactivate !== undefined && typeof candidate.deactivate !== "function") {
    throw new Error(`Plugin ${id} exports a non-function deactivate in its preload realm`);
  }
  return candidate as PluginModule;
}

import { LifecyclePhase, RealmLifecycle, type LifecycleSnapshot } from "@shared/plugin/lifecycle";
import { PluginPreloadStatus } from "@shared/contracts/plugin-manager-api";
import {
  createPluginRegistry,
  type MutablePluginRegistry,
  type Registry,
} from "@shared/plugin/registry";
import { toError } from "@shared/util";

import type { PreloadPluginModule, PreloadPluginRuntime } from "./types";

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
  /** Report per-plugin preload status back to the main process. */
  onStatus?: (id: string, status: PluginPreloadStatus, error?: string) => void;
  /** Soft per-plugin activation deadline. */
  activationTimeoutMs?: number;
}

export interface PreloadPluginRecord {
  id: string;
  lifecycle: RealmLifecycle<PreloadPluginModule>;
  readonly status: "pending" | "active" | "failed";
  readonly module: PreloadPluginModule | undefined;
  readonly error: unknown;
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
  private readonly runtime: PreloadPluginRuntime;
  private readonly pluginRegistry: MutablePluginRegistry;
  private readonly evaluate: (source: string, id: string) => unknown;
  private readonly loaders = new Map<string, () => Promise<unknown>>();
  private readonly sourceProviders = new Map<string, () => Promise<string | null>>();
  private readonly onStatus?: (id: string, status: PluginPreloadStatus, error?: string) => void;
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

    this.pluginRegistry = createPluginRegistry(this.loaders);
    this.runtime = { registry: options.registry, plugins: this.pluginRegistry };
  }

  get plugins(): ReadonlyArray<PreloadPluginRecord> {
    return this.records;
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

  enableAll(): void {
    for (const record of this.records) record.lifecycle.enable();
  }

  waitForAll(): Promise<void> {
    return Promise.all(this.records.map((record) => this.waitForDecision(record))).then(() => {});
  }

  async activateAll(): Promise<void> {
    this.enableAll();
    await this.waitForAll();
  }

  /** Evaluate and activate one plugin; used for tests and live enables. */
  add(id: string, source: string): Promise<void> {
    // A new instance must not inherit the old exports cache.
    this.pluginRegistry.forget(id);
    this.registerSource(id, async () => source);
    return this.enableRecord(id);
  }

  /** Fetch and activate one plugin. Source fetch is inside its lifecycle. */
  enable(id: string, getSource: () => Promise<string | null>): Promise<void> {
    this.pluginRegistry.forget(id);
    this.registerSource(id, getSource);
    return this.enableRecord(id);
  }

  /** Deactivate and forget one plugin; used for live disables. */
  async remove(id: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) return;

    // Drop the exports cache now. A re-enable can return early below, but the
    // new instance must never be shadowed by the old module.
    this.pluginRegistry.forget(id);
    record.lifecycle.disable();
    await record.lifecycle.waitFor(
      (snapshot) =>
        snapshot.desired ||
        snapshot.phase === LifecyclePhase.Disabled ||
        (snapshot.phase === LifecyclePhase.Failed && !snapshot.cleanupPending)
    );

    // A re-enable may have happened while the cleanup was running. The latest
    // intent wins; do not delete the record/source/loader it now owns.
    const latest = record.lifecycle.snapshot;
    if (latest.desired || latest.cleanupPending) return;
    if (!this.records.includes(record)) return;

    const index = this.records.indexOf(record);
    if (index !== -1) this.records.splice(index, 1);
    this.sourceProviders.delete(id);
    this.loaders.delete(id);
  }

  async deactivateAll(): Promise<void> {
    const records = [...this.records].reverse();
    await Promise.all(
      records.map(async (record) => {
        this.pluginRegistry.forget(record.id);
        try {
          await record.lifecycle.dispose(2000);
        } catch (error) {
          LOGGER.error(
            { pluginId: record.id, err: toError(error) },
            "Preload plugin shutdown cleanup failed"
          );
        }
      })
    );
  }

  private enableRecord(id: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) return Promise.reject(new Error(`Unknown plugin "${id}"`));
    record.lifecycle.enable();
    return this.waitForDecision(record);
  }

  private registerSource(id: string, provider: () => Promise<string | null>): void {
    this.sourceProviders.set(id, provider);
    if (this.loaders.has(id)) return;

    let lastStatus: PluginPreloadStatus | undefined;
    const lifecycle = new RealmLifecycle<PreloadPluginModule>({
      timeoutMs: this.activationTimeoutMs,
      adapter: {
        load: () => this.loadSourceModule(id),
        activate: (module) => module.activate(this.runtime),
        deactivate: (module) => module.deactivate?.(),
      },
      onChange: (snapshot) => {
        if (snapshot.phase === LifecyclePhase.Enabling && !snapshot.timedOut) {
          lastStatus = undefined;
          return;
        }
        const next = reportableStatus(snapshot);
        if (next === undefined || next === lastStatus) return;
        lastStatus = next;
        if (next === PluginPreloadStatus.Failed) {
          LOGGER.error(
            { pluginId: id, err: toError(snapshot.error) },
            "Preload plugin activation failed"
          );
        }
        this.onStatus?.(
          id,
          next,
          next === PluginPreloadStatus.Failed ? toError(snapshot.error).message : undefined
        );
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
    };
    this.records.push(record);

    this.loaders.set(id, async () => {
      if (!lifecycle.snapshot.desired) {
        throw new Error(`Plugin "${id}" is not enabled`);
      }
      const snapshot = await lifecycle.waitFor(
        (current) =>
          current.phase === LifecyclePhase.Active ||
          current.phase === LifecyclePhase.Failed ||
          current.timedOut ||
          !current.desired
      );
      if (snapshot.phase !== LifecyclePhase.Active || !snapshot.module) {
        throw new Error(`Plugin "${id}" is not active`);
      }
      return snapshot.module;
    });
  }

  private async loadSourceModule(id: string): Promise<PreloadPluginModule> {
    const provider = this.sourceProviders.get(id);
    if (!provider) throw new Error(`Plugin "${id}" has no source`);
    const source = await provider();
    if (source === null) throw new Error(`Plugin "${id}" source is unavailable`);
    return toPreloadPluginModule(this.evaluate(source, id), id);
  }

  private waitForDecision(record: PreloadPluginRecord): Promise<void> {
    return record.lifecycle
      .waitFor(
        (snapshot) =>
          snapshot.phase === LifecyclePhase.Active ||
          snapshot.phase === LifecyclePhase.Failed ||
          snapshot.timedOut ||
          (snapshot.phase === LifecyclePhase.Disabled && !snapshot.desired)
      )
      .then(() => {});
  }
}

function reportableStatus(
  snapshot: LifecycleSnapshot<PreloadPluginModule>
): PluginPreloadStatus | undefined {
  if (snapshot.phase === LifecyclePhase.Active) return PluginPreloadStatus.Active;
  if (
    snapshot.phase === LifecyclePhase.Failed ||
    (snapshot.phase === LifecyclePhase.Enabling && snapshot.timedOut)
  ) {
    return PluginPreloadStatus.Failed;
  }
  if (snapshot.phase === LifecyclePhase.Disabled && !snapshot.desired) {
    return PluginPreloadStatus.Inactive;
  }
  return undefined;
}

function toPreloadStatus(
  lifecycle: RealmLifecycle<PreloadPluginModule>
): "pending" | "active" | "failed" {
  const snapshot = lifecycle.snapshot;
  if (snapshot.phase === LifecyclePhase.Active) return "active";
  if (
    snapshot.phase === LifecyclePhase.Failed ||
    (snapshot.phase === LifecyclePhase.Enabling && snapshot.timedOut)
  ) {
    return "failed";
  }
  return "pending";
}

function toPreloadPluginModule(imported: unknown, id: string): PreloadPluginModule {
  if (imported === null || typeof imported !== "object") {
    throw new Error(`Plugin ${id} did not export a preload module object`);
  }
  const candidate = imported as Partial<PreloadPluginModule>;
  if (typeof candidate.activate !== "function") {
    throw new Error(`Plugin ${id} does not export an activate() function in its preload realm`);
  }
  if (candidate.deactivate !== undefined && typeof candidate.deactivate !== "function") {
    throw new Error(`Plugin ${id} exports a non-function deactivate in its preload realm`);
  }
  return candidate as PreloadPluginModule;
}

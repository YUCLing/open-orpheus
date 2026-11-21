import { pathToFileURL } from "node:url";

import type { PluginDesiredState } from "@shared/contracts/plugin-manager-api";
import { cacheBustUrl } from "@shared/plugin/cache-bust";
import {
  LifecycleStateKind,
  PluginDisposeStatus,
  RealmLifecycle,
  type LifecycleSnapshot,
  type PluginDisposeResult,
} from "@shared/plugin/lifecycle";
import {
  createPluginRegistry,
  type MutablePluginRegistry,
  type PluginRegistrySource,
  type Registry,
} from "@shared/plugin/registry";
import { toError } from "@shared/util";

import type { DiscoveredPlugin } from "./discover";
import type { PluginModule, PluginRuntime } from "@shared/plugin/realms/main/index";

export enum PluginStatus {
  Pending = "pending",
  Disabled = "disabled",
  Active = "active",
  Failed = "failed",
}

export interface PluginRecord {
  plugin: DiscoveredPlugin;
  lifecycle: RealmLifecycle<PluginModule>;
  readonly status: PluginStatus;
  readonly module: PluginModule | undefined;
  readonly error: unknown;
  readonly snapshot: LifecycleSnapshot<PluginModule>;
}

export interface PluginLoaderOptions {
  registry: Registry;
  plugins: DiscoveredPlugin[];
  /** Initial desired state for `activateAll`. */
  isEnabled?: (id: string) => boolean;
  /** Injectable for tests. Receives a cache-busted module URL. */
  importModule?: (entryUrl: string) => Promise<unknown>;
  /** Soft per-plugin activation and cleanup deadline. */
  activationTimeoutMs?: number;
  /** Called when a plugin's lifecycle snapshot changes. */
  onChanged?: () => void;
}

/**
 * Loads, activates, and deactivates main-realm plugin modules.
 *
 * Each plugin has one `RealmLifecycle` that serializes activation and cleanup.
 * This class adapts discovered plugins to that state machine and exposes
 * module exports separately from activation readiness.
 */
export class PluginLoader {
  private readonly records: PluginRecord[] = [];
  private readonly recordsById = new Map<string, PluginRecord>();
  /**
   * One evaluation per activation epoch, shared by lifecycle activation and
   * cross-plugin `load()`.
   *
   * Imports use a cache-busting URL, so without this cache the two callers
   * would evaluate the entry twice and observe different module instances.
   */
  private readonly moduleCache = new Map<string, Promise<PluginModule>>();
  private readonly importModule: (entryUrl: string) => Promise<unknown>;
  private readonly isEnabled: (id: string) => boolean;
  private readonly revisions = new Map<string, number>();
  private readonly pluginRegistry: MutablePluginRegistry;
  private readonly registry: Registry;

  constructor(options: PluginLoaderOptions) {
    this.importModule = options.importModule ?? ((entryUrl) => import(entryUrl));
    this.isEnabled = options.isEnabled ?? (() => true);
    this.registry = options.registry;
    const onChanged = options.onChanged;

    const sources = new Map<string, PluginRegistrySource>();

    for (const plugin of options.plugins) {
      const id = plugin.metadata.id;
      if (this.recordsById.has(id)) {
        throw new Error(`Duplicate plugin id "${id}" in the resolved catalog`);
      }

      const lifecycle = new RealmLifecycle<PluginModule>({
        timeoutMs: options.activationTimeoutMs,
        adapter: {
          load: () => this.loadModule(id),
          activate: (module) => module.activate(this.runtimeFor(id)),
          deactivate: (module) => module.deactivate?.(),
        },
        onChange: (snapshot) => {
          onChanged?.();
          if (snapshot.state.kind === LifecycleStateKind.Failed) {
            LOGGER.error(
              {
                pluginId: id,
                stage: snapshot.state.stage,
                err: toError(snapshot.state.error),
              },
              "Plugin lifecycle failed"
            );
          }
        },
      });

      const record: PluginRecord = {
        plugin,
        lifecycle,
        get status() {
          return toPluginStatus(lifecycle);
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

      sources.set(id, {
        load: () => this.loadModule(id),
        whenActive: () => this.whenActive(id),
        isReady: () => lifecycle.snapshot.state.kind === LifecycleStateKind.Running,
      });
    }

    this.pluginRegistry = createPluginRegistry(sources);
  }

  private runtimeFor(id: string): PluginRuntime {
    return { registry: this.registry, plugins: this.pluginRegistry.forPlugin(id) };
  }

  get plugins(): ReadonlyArray<PluginRecord> {
    return this.records;
  }

  /** Apply a committed desired state to one plugin. */
  setDesiredState(id: string, desired: PluginDesiredState): void {
    const record = this.require(id);
    const known = this.revisions.get(id) ?? 0;
    if (desired.revision < known) return;
    this.revisions.set(id, desired.revision);
    if (!desired.enabled) {
      // This is the path the manager uses, so it must invalidate exports and
      // readiness exactly like `deactivate` does. Otherwise a cached
      // `whenActive` result would bypass the enabled check after cleanup.
      this.pluginRegistry.forget(id);
      // The next enable starts a new evaluation epoch.
      this.moduleCache.delete(id);
    }
    record.lifecycle.applyDesiredState(desired);
  }

  async activateAll(): Promise<void> {
    const targets = this.records.filter((record) => this.isEnabled(record.plugin.metadata.id));
    for (const record of targets) {
      const id = record.plugin.metadata.id;
      record.lifecycle.applyDesiredState({ enabled: true, revision: this.revisions.get(id) ?? 0 });
    }
    await Promise.all(targets.map((record) => this.waitForDecision(record)));
  }

  async activate(id: string): Promise<void> {
    const record = this.require(id);
    if (!this.isEnabled(id)) throw new Error(`Plugin "${id}" is not enabled`);
    this.setDesiredState(id, { enabled: true, revision: this.nextRevision(id) });
    await this.waitForDecision(record);
  }

  async deactivate(id: string): Promise<void> {
    const record = this.require(id);
    // Clear the exports cache when stopping begins; no caller may receive the
    // already-deactivated module from a stale evaluation.
    this.pluginRegistry.forget(id);
    this.setDesiredState(id, { enabled: false, revision: this.nextRevision(id) });
    await this.waitForSettled(record);
  }

  /** Request a fresh attempt without changing desired state. */
  async retry(id: string): Promise<void> {
    const record = this.require(id);
    this.pluginRegistry.forget(id);
    this.moduleCache.delete(id);
    record.lifecycle.retry();
    await this.waitForDecision(record);
  }

  /** Start a retry without waiting for convergence. */
  requestRetry(id: string): void {
    this.pluginRegistry.forget(id);
    this.moduleCache.delete(id);
    this.require(id).lifecycle.retry();
  }

  async deactivateAll(): Promise<PluginDisposeResult[]> {
    // Start every cleanup within the same shutdown deadline. Awaiting each
    // dispose sequentially would let the first slow plugin consume the host's
    // shared budget before later cleanup even starts.
    const records = [...this.records].reverse();
    return Promise.all(
      records.map(async (record) => {
        this.pluginRegistry.forget(record.plugin.metadata.id);
        this.moduleCache.delete(record.plugin.metadata.id);
        try {
          const result = await record.lifecycle.dispose(2000);
          if (result.status !== "stopped") {
            LOGGER.warn(
              { pluginId: record.plugin.metadata.id, status: result.status },
              "Plugin shutdown cleanup did not complete cleanly"
            );
          }
          return result;
        } catch (error) {
          LOGGER.error(
            { pluginId: record.plugin.metadata.id, err: toError(error) },
            "Plugin shutdown cleanup failed"
          );
          return { status: PluginDisposeStatus.Abandoned };
        }
      })
    );
  }

  private nextRevision(id: string): number {
    const next = (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, next);
    return next;
  }

  private require(id: string): PluginRecord {
    const record = this.recordsById.get(id);
    if (!record) throw new Error(`Unknown plugin "${id}"`);
    return record;
  }

  private loadModule(id: string): Promise<PluginModule> {
    const record = this.require(id);
    if (!this.isEnabled(id)) return Promise.reject(new Error(`Plugin "${id}" is not enabled`));

    // Lifecycle activation and cross-plugin `load()` share this evaluation.
    // Imports are cache-busted, so without sharing they would produce two
    // different module instances for one activation.
    const cached = this.moduleCache.get(id);
    if (cached) return cached;

    const entryUrl = cacheBustUrl(pathToFileURL(record.plugin.entryPaths.main).href);
    const pending = this.importModule(entryUrl).then((imported) =>
      toPluginModule(imported, record.plugin.metadata.id)
    );
    this.moduleCache.set(id, pending);
    void pending.catch(() => {
      if (this.moduleCache.get(id) === pending) this.moduleCache.delete(id);
    });
    return pending;
  }

  private async whenActive(id: string): Promise<PluginModule> {
    const record = this.require(id);
    if (!this.isEnabled(id)) throw new Error(`Plugin "${id}" is not enabled`);
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

  private waitForDecision(record: PluginRecord): Promise<void> {
    return record.lifecycle
      .waitFor(
        (snapshot) =>
          snapshot.state.kind === LifecycleStateKind.Running ||
          snapshot.state.kind === LifecycleStateKind.Failed ||
          snapshot.state.kind === LifecycleStateKind.Hung ||
          snapshot.state.kind === LifecycleStateKind.Abandoned ||
          (snapshot.state.kind === LifecycleStateKind.Stopped && !snapshot.desired.enabled)
      )
      .then(() => {});
  }

  private waitForSettled(record: PluginRecord): Promise<void> {
    return record.lifecycle
      .waitFor(
        (snapshot) =>
          snapshot.state.kind === LifecycleStateKind.Stopped ||
          snapshot.state.kind === LifecycleStateKind.Failed ||
          snapshot.state.kind === LifecycleStateKind.Hung ||
          snapshot.state.kind === LifecycleStateKind.Abandoned ||
          snapshot.state.kind === LifecycleStateKind.Disposed
      )
      .then(() => {});
  }
}

function toPluginStatus(lifecycle: RealmLifecycle<PluginModule>): PluginStatus {
  const snapshot = lifecycle.snapshot;
  switch (snapshot.state.kind) {
    case LifecycleStateKind.Running:
      return PluginStatus.Active;
    case LifecycleStateKind.Failed:
    case LifecycleStateKind.Hung:
    case LifecycleStateKind.Abandoned:
      return PluginStatus.Failed;
    case LifecycleStateKind.Stopped:
    case LifecycleStateKind.Disposed:
      return snapshot.desired.enabled ? PluginStatus.Pending : PluginStatus.Disabled;
    default:
      return PluginStatus.Pending;
  }
}

function toPluginModule(imported: unknown, id: string): PluginModule {
  if (imported === null || typeof imported !== "object") {
    throw new Error(`Plugin ${id} did not export a module object`);
  }
  const candidate = imported as Partial<PluginModule>;
  if (typeof candidate.activate !== "function") {
    throw new Error(`Plugin ${id} does not export an activate() function`);
  }
  if (candidate.deactivate !== undefined && typeof candidate.deactivate !== "function") {
    throw new Error(`Plugin ${id} exports a non-function deactivate`);
  }
  return candidate as PluginModule;
}

export type { LifecycleSnapshot };

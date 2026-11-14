import { pathToFileURL } from "node:url";

import { LifecyclePhase, RealmLifecycle, type LifecycleSnapshot } from "@shared/plugin/lifecycle";
import {
  createPluginRegistry,
  type MutablePluginRegistry,
  type Registry,
} from "@shared/plugin/registry";
import { toError } from "@shared/util";

import type { DiscoveredPlugin } from "./discover";
import type { PluginModule, PluginRuntime } from "./types";

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
}

export interface PluginLoaderOptions {
  registry: Registry;
  plugins: DiscoveredPlugin[];
  /** Only plugins for which this returns true are activated by `activateAll`. */
  isEnabled?: (id: string) => boolean;
  /** Injectable for tests; defaults to a dynamic ESM import. */
  importModule?: (entryPath: string) => Promise<unknown>;
  /** Soft per-plugin activation deadline. */
  activationTimeoutMs?: number;
  /** Called when a plugin's lifecycle snapshot changes. */
  onChanged?: () => void;
}

/**
 * Loads, activates and deactivates plugin trees.
 *
 * Each plugin has one `RealmLifecycle`: desired state, actual phase, soft
 * timeout ownership, generation-checked async results, and cleanup-before-retry
 * all live in that state machine. This class is only the main-realm adapter.
 */
export class PluginLoader {
  private readonly records: PluginRecord[] = [];
  private readonly ids = new Set<string>();
  private readonly runtime: PluginRuntime;
  private readonly importModule: (entryPath: string) => Promise<unknown>;
  private readonly isEnabled: (id: string) => boolean;
  private readonly pluginRegistry: MutablePluginRegistry;

  constructor(options: PluginLoaderOptions) {
    this.importModule =
      options.importModule ?? ((entryPath) => import(pathToFileURL(entryPath).href));
    this.isEnabled = options.isEnabled ?? (() => true);
    const onChanged = options.onChanged;

    const loaders = new Map<string, () => Promise<unknown>>();
    for (const plugin of options.plugins) {
      const id = plugin.metadata.id;
      if (this.ids.has(id)) {
        LOGGER.warn({ pluginId: id }, "Ignoring duplicate plugin id");
        continue;
      }
      this.ids.add(id);

      const lifecycle = new RealmLifecycle<PluginModule>({
        timeoutMs: options.activationTimeoutMs,
        adapter: {
          load: async () => toPluginModule(await this.importModule(plugin.entryPaths.main), id),
          activate: (module) => module.activate(this.runtime),
          deactivate: (module) => module.deactivate?.(),
        },
        onChange: (snapshot) => {
          onChanged?.();
          if (snapshot.phase === LifecyclePhase.Failed && snapshot.error) {
            LOGGER.error(
              { pluginId: id, err: toError(snapshot.error) },
              "Plugin activation failed"
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
      };
      this.records.push(record);

      loaders.set(id, async () => {
        const initial = lifecycle.snapshot;
        if (!initial.desired) {
          if (this.isEnabled(id) && initial.phase === LifecyclePhase.Disabled) {
            lifecycle.enable();
          } else {
            throw new Error(`Plugin "${id}" is not enabled`);
          }
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

    this.pluginRegistry = createPluginRegistry(loaders);
    this.runtime = { registry: options.registry, plugins: this.pluginRegistry };
  }

  get plugins(): ReadonlyArray<PluginRecord> {
    return this.records;
  }

  async activateAll(): Promise<void> {
    const targets = this.records.filter((record) => this.isEnabled(record.plugin.metadata.id));
    for (const record of targets) record.lifecycle.enable();
    await Promise.all(targets.map((record) => this.waitForDecision(record)));
  }

  async activate(id: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.plugin.metadata.id === id);
    if (!record) throw new Error(`Unknown plugin "${id}"`);
    if (!this.isEnabled(id)) throw new Error(`Plugin "${id}" is not enabled`);
    record.lifecycle.enable();
    await this.waitForDecision(record);
  }

  async deactivate(id: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.plugin.metadata.id === id);
    if (!record) throw new Error(`Unknown plugin "${id}"`);
    // Clear the exports cache when stopping begins. The wait may time out, but
    // no caller may receive the already-deactivated module from the cache.
    this.pluginRegistry.forget(id);
    record.lifecycle.disable();
    await this.waitForSettled(record);
  }

  async deactivateAll(): Promise<void> {
    // Start every cleanup within the same shutdown deadline. Awaiting each
    // dispose sequentially would let the first slow plugin consume the host's
    // shared 2s budget before the later cleanup even starts.
    const records = [...this.records].reverse();
    await Promise.all(
      records.map(async (record) => {
        this.pluginRegistry.forget(record.plugin.metadata.id);
        try {
          await record.lifecycle.dispose(2000);
        } catch (error) {
          LOGGER.error(
            { pluginId: record.plugin.metadata.id, err: toError(error) },
            "Plugin shutdown cleanup failed"
          );
        }
      })
    );
  }

  private async waitForDecision(record: PluginRecord): Promise<void> {
    await record.lifecycle.waitFor(
      (snapshot) =>
        snapshot.phase === LifecyclePhase.Active ||
        snapshot.phase === LifecyclePhase.Failed ||
        snapshot.timedOut ||
        (snapshot.phase === LifecyclePhase.Disabled && !snapshot.desired)
    );
  }

  private async waitForSettled(record: PluginRecord): Promise<void> {
    await record.lifecycle.waitFor(
      (snapshot) =>
        snapshot.phase === LifecyclePhase.Disabled ||
        snapshot.phase === LifecyclePhase.Failed ||
        snapshot.timedOut
    );
  }
}

function toPluginStatus(lifecycle: RealmLifecycle<PluginModule>): PluginStatus {
  const snapshot = lifecycle.snapshot;
  if (snapshot.phase === LifecyclePhase.Active) return PluginStatus.Active;
  if (
    snapshot.phase === LifecyclePhase.Failed ||
    (snapshot.phase === LifecyclePhase.Enabling && snapshot.timedOut)
  ) {
    return PluginStatus.Failed;
  }
  if (snapshot.phase === LifecyclePhase.Disabled && !snapshot.desired) {
    return PluginStatus.Disabled;
  }
  return PluginStatus.Pending;
}

export type { LifecycleSnapshot };

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

import {
  PluginConfigurationFailureStage,
  PluginConfigurationStateKind,
  type PluginConfigurationState,
  type PluginRealmActivationOutcome,
} from "@shared/contracts/plugin-configuration";
import { cacheBustUrl } from "@shared/plugin/cache-bust";
import type { ConfigurationModule, ConfigurationUnmount } from "@shared/plugin/configuration";
import { toError } from "@shared/util";

export interface PluginConfigurationRequest {
  pluginId: string;
  entryUrl: string;
  /** Committed desired-state revision this request belongs to. */
  revision: number;
  /** Whether the plugin-manager preload realm must be running first. */
  requiresPreload: boolean;
  root: HTMLDivElement;
}

export interface PluginConfigurationLoaderOptions {
  waitForRealm(pluginId: string): Promise<PluginRealmActivationOutcome>;
  /** Injectable for tests. Defaults to a native ESM import. */
  importModule?(url: string): Promise<unknown>;
}

interface CachedModule {
  epoch: number;
  value: ConfigurationModule;
}

interface MountedConfiguration {
  epoch: number;
  generation: number;
  /** Cleanup returned by `mount()`, when the plugin provided one. */
  unmount?: ConfigurationUnmount;
  controller: AbortController;
}

interface ConfigurationRecord {
  state: PluginConfigurationState;
  /** Module evaluation epoch. Incremented by dispose/retry only. */
  epoch: number;
  /** Mount request generation. Incremented by every open/close/dispose. */
  mountGeneration: number;
  /** Highest desired-state revision this record has seen. */
  revision: number;
  attempt: number;
  module?: CachedModule;
  mounted?: MountedConfiguration;
  /**
   * Controller for a `mount()` that is still awaiting, so close/dispose can
   * abort it immediately instead of waiting for the serialized queue.
   */
  pendingController?: AbortController;
  queue: Promise<unknown>;
}

/**
 * Loads and mounts plugin configuration modules.
 *
 * The host owns every step: import, validation, mounting, teardown, and stale
 * result rejection. Plugins only export `mount()` and never receive the plugin
 * manager's registration objects.
 */
export class PluginConfigurationLoader extends EventTarget {
  private readonly records = new Map<string, ConfigurationRecord>();
  private readonly waitForRealm: (pluginId: string) => Promise<PluginRealmActivationOutcome>;
  private readonly importModule: (url: string) => Promise<unknown>;

  constructor(options: PluginConfigurationLoaderOptions) {
    super();
    this.waitForRealm = options.waitForRealm;
    this.importModule =
      options.importModule ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<unknown>);
  }

  /** Copy of every record's state, suitable for rendering. */
  snapshot(): Record<string, PluginConfigurationState> {
    const snapshot: Record<string, PluginConfigurationState> = {};
    for (const [pluginId, record] of this.records) {
      snapshot[pluginId] = { ...record.state };
    }
    return snapshot;
  }

  /**
   * Load the module if needed and mount it into `request.root`.
   *
   * If the plugin-manager preload realm is declared, its activation is awaited
   * first so preload-exposed APIs exist before the configuration module runs.
   */
  async open(request: PluginConfigurationRequest): Promise<void> {
    const record = this.record(request.pluginId);
    if (request.revision < record.revision) return;
    if (request.revision > record.revision) {
      // The plugin was toggled since this record started. Even when the UI
      // never rendered the disabled state, a re-enable starts a fresh epoch.
      record.module = undefined;
      record.epoch++;
    }
    record.revision = request.revision;

    // A new mount request supersedes a previous one that is still awaiting.
    record.pendingController?.abort();
    const epoch = record.epoch;
    const generation = ++record.mountGeneration;
    await this.enqueue(record, () => this.openNow(record, request, epoch, generation));
  }

  /** Unmount the current configuration view, keeping the module cached. */
  async close(pluginId: string): Promise<void> {
    const record = this.record(pluginId);
    record.pendingController?.abort();
    record.mountGeneration++;
    await this.enqueue(record, async () => {
      const unmounted = await this.unmountMounted(record, record.revision, false);
      if (!unmounted) return;
      this.setState(record, {
        kind: record.module
          ? PluginConfigurationStateKind.Ready
          : PluginConfigurationStateKind.Unloaded,
        desiredRevision: record.revision,
        attempt: record.attempt,
      });
    });
  }

  /** Drop the module and unmount. Used for retry, disable, and unload. */
  async dispose(pluginId: string, revision?: number): Promise<void> {
    const record = this.record(pluginId);
    if (revision !== undefined) {
      if (revision < record.revision) return;
      record.revision = revision;
    }

    // Invalidate synchronously so an import or mount already in flight cannot
    // install itself after cleanup has been requested. Abort an awaiting
    // mount() now; otherwise it could block this cleanup indefinitely.
    record.epoch++;
    record.mountGeneration++;
    record.module = undefined;
    record.pendingController?.abort();

    await this.enqueue(record, async () => {
      const unmounted = await this.unmountMounted(record, record.revision, true);
      if (!unmounted) return;
      this.setState(record, {
        kind: PluginConfigurationStateKind.Unloaded,
        desiredRevision: record.revision,
        attempt: record.attempt,
      });
    });
  }

  /** Retry a failed configuration module from a fresh evaluation epoch. */
  async retry(request: PluginConfigurationRequest): Promise<void> {
    await this.dispose(request.pluginId, request.revision);
    await this.open(request);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.records.keys()].map((pluginId) => this.dispose(pluginId)));
  }

  private async openNow(
    record: ConfigurationRecord,
    request: PluginConfigurationRequest,
    epoch: number,
    generation: number
  ): Promise<void> {
    if (this.isStale(record, epoch, generation)) return;

    if (record.mounted) {
      const unmounted = await this.unmountMounted(record, request.revision, false);
      if (!unmounted || this.isStale(record, epoch, generation)) return;
    }

    if (request.requiresPreload) {
      this.setState(record, {
        kind: PluginConfigurationStateKind.WaitingForPreload,
        desiredRevision: request.revision,
        attempt: record.attempt,
      });
      const outcome = await this.waitForRealm(request.pluginId);
      if (this.isStale(record, epoch, generation)) return;
      if (outcome.kind !== "running") {
        const detail = outcome.kind === "failed" ? outcome.error : undefined;
        this.fail(
          record,
          PluginConfigurationFailureStage.Preload,
          detail ?? "插件管理器运行环境不可用",
          false
        );
        return;
      }
    }

    let module = record.module?.epoch === epoch ? record.module.value : undefined;
    if (!module) {
      const attempt = ++record.attempt;
      this.setState(record, {
        kind: PluginConfigurationStateKind.Loading,
        desiredRevision: request.revision,
        attempt,
      });

      let imported: unknown;
      try {
        imported = await this.importModule(this.importUrl(request.entryUrl));
      } catch (error) {
        if (!this.isStale(record, epoch, generation)) {
          this.fail(record, PluginConfigurationFailureStage.Import, error);
        }
        return;
      }

      try {
        module = validateModule(imported, request.pluginId);
      } catch (error) {
        if (!this.isStale(record, epoch, generation)) {
          this.fail(record, PluginConfigurationFailureStage.Validate, error);
        }
        return;
      }

      // Cache the evaluation even when the mount request that triggered it was
      // superseded, as long as its epoch is still current.
      if (record.epoch === epoch) record.module = { epoch, value: module };
      if (this.isStale(record, epoch, generation)) return;
    }

    const controller = new AbortController();
    // Store the controller before awaiting mount so close()/dispose() can
    // abort it immediately rather than waiting behind the serialized queue.
    record.pendingController = controller;
    this.setState(record, {
      kind: PluginConfigurationStateKind.Mounting,
      desiredRevision: request.revision,
      attempt: record.attempt,
    });

    let unmount: ConfigurationUnmount | undefined;
    try {
      unmount = validateUnmount(
        await module.mount(request.root, {
          pluginId: request.pluginId,
          assetsBaseUrl: pluginAssetsBaseUrl(request.pluginId),
          signal: controller.signal,
        }),
        request.pluginId
      );
    } catch (error) {
      if (record.pendingController === controller) record.pendingController = undefined;
      if (!this.isStale(record, epoch, generation)) {
        this.fail(record, PluginConfigurationFailureStage.Mount, error);
      }
      return;
    }
    if (record.pendingController === controller) record.pendingController = undefined;

    if (this.isStale(record, epoch, generation)) {
      controller.abort();
      // Retain cleanup that refuses to run, so the queued cleanup can retry it
      // instead of reporting a clean shutdown it did not achieve.
      if (unmount) {
        try {
          await unmount();
        } catch (error) {
          record.mounted = { epoch, generation, unmount, controller };
          this.fail(record, PluginConfigurationFailureStage.Unmount, error);
        }
      }
      return;
    }

    record.mounted = { epoch, generation, unmount, controller };
    this.setState(record, {
      kind: PluginConfigurationStateKind.Mounted,
      desiredRevision: request.revision,
      attempt: record.attempt,
    });
  }

  /**
   * Unmount the current instance. Returns false when cleanup failed and the
   * failure was recorded; callers must not overwrite it.
   */
  private async unmountMounted(
    record: ConfigurationRecord,
    revision: number,
    invalidateEpoch: boolean
  ): Promise<boolean> {
    const mounted = record.mounted;
    if (!mounted) return true;

    mounted.controller.abort();
    if (invalidateEpoch && mounted.epoch === record.epoch) record.module = undefined;

    this.setState(record, {
      kind: PluginConfigurationStateKind.Unmounting,
      desiredRevision: revision,
      attempt: record.attempt,
    });
    try {
      await mounted.unmount?.();
      // Keep the cleanup on failure so a later retry can attempt it again
      // instead of claiming success with effects still mounted.
      if (record.mounted === mounted) record.mounted = undefined;
      return true;
    } catch (error) {
      this.fail(record, PluginConfigurationFailureStage.Unmount, error);
      return false;
    }
  }

  private isStale(record: ConfigurationRecord, epoch: number, generation: number): boolean {
    return record.epoch !== epoch || record.mountGeneration !== generation;
  }

  private fail(
    record: ConfigurationRecord,
    stage: PluginConfigurationFailureStage,
    error: unknown,
    retryable = true
  ): void {
    this.setState(record, {
      kind: PluginConfigurationStateKind.Failed,
      desiredRevision: record.revision,
      attempt: record.attempt,
      stage,
      error: toError(error).message,
      retryable,
    });
  }

  private setState(record: ConfigurationRecord, state: PluginConfigurationState): void {
    record.state = state;
    this.dispatchEvent(new Event("changed"));
  }

  private record(pluginId: string): ConfigurationRecord {
    let record = this.records.get(pluginId);
    if (!record) {
      record = {
        state: {
          kind: PluginConfigurationStateKind.Unloaded,
          desiredRevision: 0,
          attempt: 0,
        },
        epoch: 0,
        mountGeneration: 0,
        revision: 0,
        attempt: 0,
        queue: Promise.resolve(),
      };
      this.records.set(pluginId, record);
    }
    return record;
  }

  private enqueue<T>(record: ConfigurationRecord, task: () => Promise<T>): Promise<T> {
    const run = record.queue.then(task, task);
    record.queue = run.catch(() => {});
    return run;
  }

  private importUrl(entryUrl: string): string {
    return cacheBustUrl(entryUrl);
  }
}

function validateModule(imported: unknown, pluginId: string): ConfigurationModule {
  if (imported === null || typeof imported !== "object") {
    throw new Error(`Plugin ${pluginId} configuration module is not an object`);
  }
  const candidate = imported as Partial<ConfigurationModule>;
  if (typeof candidate.mount !== "function") {
    throw new Error(`Plugin ${pluginId} configuration module does not export mount()`);
  }
  return candidate as ConfigurationModule;
}

function validateUnmount(result: unknown, pluginId: string): ConfigurationUnmount | undefined {
  if (result === undefined) return undefined;
  if (typeof result !== "function") {
    throw new Error(
      `Plugin ${pluginId} configuration mount() must return an unmount function or nothing`
    );
  }
  return result as ConfigurationUnmount;
}

/**
 * Root of the plugin's `assets/` directory.
 *
 * The configuration entry lives somewhere beneath `assets/`, so its own
 * directory is not the documented base (`assets://plugins/<id>/`).
 */
function pluginAssetsBaseUrl(pluginId: string): string {
  return `assets://plugins/${encodeURIComponent(pluginId)}/`;
}

import path from "node:path";

import {
  PluginAvailabilityKind,
  PluginFailureStage,
  PluginKind,
  PluginLayer,
  PluginPresentationStatus,
  PluginRuntimeStateKind,
  type PluginAvailability,
  type PluginDesiredState,
  type PluginManagerEntry,
  type PluginManagerState,
  type PluginRealmReport,
  type PluginRealmSummary,
  type PluginShadowedSource,
  type SerializablePluginRuntimeState,
} from "@shared/contracts/plugin-manager-api";
import { serializeRuntimeState } from "@shared/plugin/runtime-state";
import { LOADED_REALM_IDS } from "virtual:open-orpheus/realm-runtime";
import { toError } from "@shared/util";

import { PluginCatalogEntryKind, type PluginCatalog, type PluginCatalogEntry } from "./catalog";
import type { DiscoveredPlugin } from "./discover";
import type { PluginLoader, PluginRecord } from "./loader";
import type { PluginStateStore } from "./state";

interface StoredRealmReport {
  desiredRevision: number;
  attempt: number;
  state: SerializablePluginRuntimeState;
}

export interface PluginManagerOptions {
  loader: PluginLoader;
  state: PluginStateStore;
  catalog: PluginCatalog;
  /** Called after any desired state or runtime state change. */
  onChanged?: () => void;
  /** Called with committed desired state for realms this plugin declares. */
  onDesiredChanged?: (id: string, realm: string, desired: PluginDesiredState) => void;
  /** Called to retry the plugin in each realm window it declares. */
  onRetryRequested?: (id: string, realm: string) => void;
}

/**
 * Combines the resolved plugin catalog, persisted intent, and per-window
 * runtime reports into the facts the manager UI renders.
 */
export class PluginManager {
  private readonly loader: PluginLoader;
  private readonly state: PluginStateStore;
  private readonly catalog: PluginCatalog;
  private readonly onChanged?: () => void;
  private readonly onDesiredChanged?: (
    id: string,
    realm: string,
    desired: PluginDesiredState
  ) => void;
  private readonly onRetryRequested?: (id: string, realm: string) => void;

  /** realm host windows, keyed by webContents id. */
  private readonly hosts = new Map<number, string>();
  /** runtime reports, keyed by webContents id then plugin id. */
  private readonly reports = new Map<number, Map<string, StoredRealmReport>>();
  /** Serialized commands per plugin. */
  private readonly commands = new Map<string, Promise<unknown>>();

  constructor(options: PluginManagerOptions) {
    this.loader = options.loader;
    this.state = options.state;
    this.catalog = options.catalog;
    this.onChanged = options.onChanged;
    this.onDesiredChanged = options.onDesiredChanged;
    this.onRetryRequested = options.onRetryRequested;
  }

  list(): PluginManagerState {
    const entries: PluginManagerEntry[] = [];

    for (const entry of this.catalog.entries) {
      entries.push(
        entry.kind === PluginCatalogEntryKind.Selected
          ? this.selectedEntry(entry.id, entry.plugin, entry.shadowed)
          : this.conflictEntry(entry)
      );
    }

    for (const candidate of this.catalog.invalid) {
      entries.push(this.invalidEntry(candidate.source, candidate.layer, candidate.error));
    }

    return { available: true, plugins: entries };
  }

  setEnabled(id: string, enabled: boolean): Promise<PluginManagerState> {
    return this.enqueue(id, async () => {
      const plugin = this.requireSelected(id);
      const desired = await this.state.setEnabled(id, plugin.kind, enabled);
      this.loader.setDesiredState(id, desired);
      this.publishDesired(id, plugin, desired);
      this.onChanged?.();
      return this.list();
    });
  }

  retry(id: string): Promise<PluginManagerState> {
    return this.enqueue(id, async () => {
      const plugin = this.requireSelected(id);
      if (!this.state.isEnabled(id, plugin.kind)) {
        throw new Error(`Plugin "${id}" is disabled; enable it instead of retrying`);
      }
      this.loader.requestRetry(id);
      // The main realm may already be healthy; the failed instances usually
      // live in window realms, so forward the retry there as well.
      for (const realm of LOADED_REALM_IDS) {
        if (plugin.metadata.realms[realm]) this.onRetryRequested?.(id, realm);
      }
      this.onChanged?.();
      return this.list();
    });
  }

  /** Whether the plugin should be activated (used for the preload manifest). */
  isEnabled(id: string): boolean {
    const plugin = this.catalog.selected.get(id);
    return plugin ? this.state.isEnabled(id, plugin.kind) : false;
  }

  /** The selected plugin tree, if it exists. Also serves disabled plugins' assets. */
  getPlugin(id: string): DiscoveredPlugin | undefined {
    return this.catalog.selected.get(id);
  }

  /** Register a window as the host of a plugin realm. */
  registerHost(webContentsId: number, realm: string): void {
    if (!LOADED_REALM_IDS.includes(realm)) return;
    this.hosts.set(webContentsId, realm);
    // A page reload reuses the same webContents id. Reports from the previous
    // document are stale; the new bootstrap only covers currently enabled
    // plugins, so they would otherwise never be overwritten.
    this.reports.delete(webContentsId);
    this.onChanged?.();
  }

  /** Drop a destroyed window's host registration and reports. */
  unregisterHost(webContentsId: number): void {
    this.hosts.delete(webContentsId);
    this.reports.delete(webContentsId);
    this.onChanged?.();
  }

  isHostFor(webContentsId: number, realm: string): boolean {
    return this.hosts.get(webContentsId) === realm;
  }

  /** Live windows hosting a realm. */
  hostsForRealm(realm: string): number[] {
    const ids: number[] = [];
    for (const [webContentsId, hostRealm] of this.hosts) {
      if (hostRealm === realm) ids.push(webContentsId);
    }
    return ids;
  }

  /** Record a revisioned runtime report from one window. */
  setRealmReport(webContentsId: number, report: PluginRealmReport): void {
    if (this.hosts.get(webContentsId) !== report.realm) return;
    const plugin = this.catalog.selected.get(report.id);
    if (!plugin || !plugin.metadata.realms[report.realm]) return;

    const current = this.state.desired(report.id, plugin.kind);
    if (report.desiredRevision < current.revision) return;

    const byPlugin = this.reports.get(webContentsId);
    if (
      report.state.kind === PluginRuntimeStateKind.Stopped ||
      report.state.kind === PluginRuntimeStateKind.Disposed
    ) {
      // A clean stop is not a live instance any more. Keeping it would leave
      // "已停止" entries in the plugin manager after the plugin is disabled.
      if (byPlugin?.delete(report.id)) {
        if (byPlugin.size === 0) this.reports.delete(webContentsId);
        this.onChanged?.();
      }
      return;
    }

    let reports = byPlugin;
    if (!reports) {
      reports = new Map();
      this.reports.set(webContentsId, reports);
    }
    reports.set(report.id, {
      desiredRevision: report.desiredRevision,
      attempt: report.attempt,
      state: report.state,
    });
    this.onChanged?.();
  }

  /** Desired state for a selected plugin, or undefined when unavailable. */
  desiredFor(id: string): PluginDesiredState | undefined {
    const plugin = this.catalog.selected.get(id);
    return plugin ? this.state.desired(id, plugin.kind) : undefined;
  }

  private selectedEntry(
    id: string,
    plugin: DiscoveredPlugin,
    shadowed: ReadonlyArray<{ layer: PluginLayer; source: string }>
  ): PluginManagerEntry {
    const record = this.loaderRecord(id);
    const desired = this.state.desired(id, plugin.kind);
    const main: SerializablePluginRuntimeState = record
      ? serializeRuntimeState(record.snapshot.state)
      : { kind: PluginRuntimeStateKind.Stopped, desiredRevision: desired.revision };

    const realms: Record<string, PluginRealmSummary> = {};
    for (const realm of LOADED_REALM_IDS) {
      if (!plugin.metadata.realms[realm]) continue;
      realms[realm] = this.realmSummary(id, realm);
    }

    const shadowedSources: PluginShadowedSource[] = shadowed.map((candidate) => ({
      layer: candidate.layer,
      path: candidate.source,
    }));

    const availability: PluginAvailability = { kind: PluginAvailabilityKind.Available };
    return {
      id,
      name: plugin.metadata.name,
      version: plugin.metadata.version,
      description: plugin.metadata.description,
      author: plugin.metadata.author,
      license: plugin.metadata.license,
      icon: plugin.metadata.icon ? pluginAssetsUrl(id, plugin.metadata.icon) : undefined,
      kind: plugin.kind,
      layer: layerOf(plugin.kind),
      desired,
      enabled: desired.enabled,
      availability,
      shadowed: shadowedSources,
      main,
      realms,
      configuration: {
        declared: plugin.metadata.configuration !== undefined,
        url: plugin.metadata.configuration
          ? pluginAssetsUrl(id, plugin.metadata.configuration)
          : undefined,
      },
      presentation: presentationFor(desired, availability, main, realms),
      error: main.error,
    };
  }

  private conflictEntry(
    entry: Extract<PluginCatalogEntry, { kind: PluginCatalogEntryKind.Conflict }>
  ): PluginManagerEntry {
    const first = entry.candidates.find((candidate) => candidate.plugin)?.plugin;
    const desired: PluginDesiredState = { enabled: false, revision: 0 };
    return {
      id: entry.id,
      name: first?.metadata.name ?? entry.id,
      version: first?.metadata.version ?? "",
      description: first?.metadata.description,
      author: first?.metadata.author,
      kind: entry.layer === PluginLayer.Builtin ? PluginKind.Builtin : PluginKind.User,
      layer: entry.layer,
      desired,
      enabled: false,
      availability: {
        kind: PluginAvailabilityKind.Conflict,
        paths: entry.candidates.map((candidate) => candidate.source),
      },
      shadowed: [],
      main: { kind: PluginRuntimeStateKind.Stopped, desiredRevision: 0 },
      realms: {},
      configuration: { declared: false },
      presentation: PluginPresentationStatus.Unavailable,
      error: `Conflicting plugin id "${entry.id}" in the ${entry.layer} layer`,
    };
  }

  private invalidEntry(id: string, layer: PluginLayer, error: unknown): PluginManagerEntry {
    const desired: PluginDesiredState = { enabled: false, revision: 0 };
    return {
      id,
      name: path.basename(id),
      version: "",
      kind: layer === PluginLayer.Builtin ? PluginKind.Builtin : PluginKind.User,
      layer,
      desired,
      enabled: false,
      availability: {
        kind: PluginAvailabilityKind.Invalid,
        path: id,
        error: toError(error).message,
      },
      shadowed: [],
      main: { kind: PluginRuntimeStateKind.Stopped, desiredRevision: 0 },
      realms: {},
      configuration: { declared: false },
      presentation: PluginPresentationStatus.Unavailable,
      error: toError(error).message,
    };
  }

  private realmSummary(id: string, realm: string): PluginRealmSummary {
    let hostCount = 0;
    for (const hostRealm of this.hosts.values()) {
      if (hostRealm === realm) hostCount++;
    }

    const instances: PluginRealmSummary["instances"] = [];
    const counts: Partial<Record<PluginRuntimeStateKind, number>> = {};
    for (const [webContentsId, byPlugin] of this.reports) {
      if (this.hosts.get(webContentsId) !== realm) continue;
      const report = byPlugin.get(id);
      if (!report) continue;
      instances.push({ webContentsId, state: report.state });
      counts[report.state.kind] = (counts[report.state.kind] ?? 0) + 1;
    }

    return { declared: true, hostCount, instances, counts };
  }

  private loaderRecord(id: string): PluginRecord | undefined {
    return this.loader.plugins.find((record) => record.plugin.metadata.id === id);
  }

  private requireSelected(id: string): DiscoveredPlugin {
    const plugin = this.catalog.selected.get(id);
    if (!plugin) {
      const entry = this.catalog.entries.find((candidate) => candidate.id === id);
      if (entry?.kind === PluginCatalogEntryKind.Conflict) {
        throw new Error(`Plugin "${id}" is unavailable because of a duplicate id`);
      }
      throw new Error(`Unknown plugin "${id}"`);
    }
    return plugin;
  }

  private publishDesired(id: string, plugin: DiscoveredPlugin, desired: PluginDesiredState): void {
    for (const realm of LOADED_REALM_IDS) {
      if (!plugin.metadata.realms[realm]) continue;
      this.onDesiredChanged?.(id, realm, desired);
    }
  }

  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.commands.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.commands.set(
      id,
      next.catch(() => {})
    );
    return next;
  }
}

function layerOf(kind: PluginKind): PluginLayer {
  return kind === PluginKind.Builtin ? PluginLayer.Builtin : PluginLayer.User;
}

function presentationFor(
  desired: PluginDesiredState,
  availability: PluginAvailability,
  main: SerializablePluginRuntimeState,
  realms: Record<string, PluginRealmSummary>
): PluginPresentationStatus {
  if (availability.kind !== PluginAvailabilityKind.Available) {
    return PluginPresentationStatus.Unavailable;
  }

  const instances = Object.values(realms).flatMap((summary) => summary.instances);
  const isCleanupFailure = (state: SerializablePluginRuntimeState) =>
    (state.kind === PluginRuntimeStateKind.Failed || state.kind === PluginRuntimeStateKind.Hung) &&
    state.stage === PluginFailureStage.Deactivate;

  const cleanupFailed =
    isCleanupFailure(main) || instances.some((instance) => isCleanupFailure(instance.state));
  const busyInstance = instances.some(
    (instance) =>
      instance.state.kind === PluginRuntimeStateKind.Running ||
      instance.state.kind === PluginRuntimeStateKind.Starting ||
      instance.state.kind === PluginRuntimeStateKind.Stopping ||
      instance.state.kind === PluginRuntimeStateKind.Hung
  );

  if (!desired.enabled) {
    if (cleanupFailed) return PluginPresentationStatus.CleanupFailed;
    // A hung activation still owns the operation; cleanup has not started.
    // Do not claim the plugin is disabled while it may still have effects.
    if (
      main.kind === PluginRuntimeStateKind.Stopping ||
      main.kind === PluginRuntimeStateKind.Starting ||
      main.kind === PluginRuntimeStateKind.Hung ||
      busyInstance
    ) {
      return PluginPresentationStatus.Stopping;
    }
    return PluginPresentationStatus.Disabled;
  }

  if (
    main.kind === PluginRuntimeStateKind.Failed ||
    main.kind === PluginRuntimeStateKind.Hung ||
    main.kind === PluginRuntimeStateKind.Abandoned
  ) {
    return PluginPresentationStatus.Failed;
  }
  if (
    main.kind === PluginRuntimeStateKind.Stopped ||
    main.kind === PluginRuntimeStateKind.Starting ||
    main.kind === PluginRuntimeStateKind.Stopping
  ) {
    return PluginPresentationStatus.Starting;
  }

  const instantiated = Object.values(realms).filter((summary) => summary.hostCount > 0);
  const degraded = instances.some(
    (instance) =>
      instance.state.kind === PluginRuntimeStateKind.Failed ||
      instance.state.kind === PluginRuntimeStateKind.Hung ||
      instance.state.kind === PluginRuntimeStateKind.Abandoned
  );
  if (degraded) return PluginPresentationStatus.Degraded;

  const missing = instantiated.some((summary) => summary.instances.length < summary.hostCount);
  const starting = instances.some(
    (instance) =>
      instance.state.kind === PluginRuntimeStateKind.Starting ||
      instance.state.kind === PluginRuntimeStateKind.Stopping
  );
  if (missing || starting) return PluginPresentationStatus.Starting;

  return PluginPresentationStatus.Running;
}

function pluginAssetsUrl(id: string, assetPath: string): string {
  const encodedPath = assetPath.split("/").map(encodeURIComponent).join("/");
  return `assets://plugins/${encodeURIComponent(id)}/${encodedPath}`;
}

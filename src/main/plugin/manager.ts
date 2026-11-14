import {
  PluginActivationStatus,
  PluginPreloadStatus,
  type PluginManagerEntry,
  type PluginManagerState,
} from "@shared/contracts/plugin-manager-api";
import { toError } from "@shared/util";

import { PluginStatus, type PluginLoader, type PluginRecord } from "./loader";
import type { DiscoveredPlugin } from "./discover";
import type { PluginStateStore } from "./state";

/** Combines the persisted enable intent with the loader's runtime status. */
export class PluginManager {
  private readonly preloadStates = new Map<
    number,
    Map<string, { status: PluginPreloadStatus; error?: string }>
  >();

  constructor(
    private readonly loader: PluginLoader,
    private readonly state: PluginStateStore,
    /** Called after a preload-realm plugin's enable state is persisted and applied. */
    private readonly onPreloadChanged?: (id: string, enabled: boolean) => void
  ) {}

  list(): PluginManagerState {
    return {
      available: true,
      plugins: this.loader.plugins.map((record) => this.toEntry(record)),
    };
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginManagerState> {
    const record = this.find(id);
    if (!record) throw new Error(`Unknown plugin "${id}"`);

    await this.state.setEnabled(id, enabled);
    if (enabled) {
      await this.loader.activate(id);
    } else {
      await this.loader.deactivate(id);
    }
    if (record.plugin.metadata.realms.preload) {
      this.onPreloadChanged?.(id, enabled);
    }
    return this.list();
  }

  /** Whether the plugin should be activated (used for the preload manifest). */
  isEnabled(id: string): boolean {
    const record = this.find(id);
    return record ? this.state.isEnabled(id, record.plugin.kind) : false;
  }

  /** The discovered plugin tree, if it exists. Also serves disabled plugins' assets. */
  getPlugin(id: string): DiscoveredPlugin | undefined {
    return this.find(id)?.plugin;
  }

  private find(id: string): PluginRecord | undefined {
    return this.loader.plugins.find((record) => record.plugin.metadata.id === id);
  }

  /** Record a preload status report from one window. */
  setPreloadStatus(
    webContentsId: number,
    id: string,
    status: PluginPreloadStatus,
    error?: string
  ): void {
    let states = this.preloadStates.get(webContentsId);
    if (!states) {
      states = new Map();
      this.preloadStates.set(webContentsId, states);
    }
    states.set(id, { status, error });
  }

  /** Drop all preload reports when their window goes away. */
  clearPreloadStatus(webContentsId: number): void {
    this.preloadStates.delete(webContentsId);
  }

  private preloadStatusFor(
    id: string
  ): { status: PluginPreloadStatus; error?: string } | undefined {
    let result: { status: PluginPreloadStatus; error?: string } | undefined;
    for (const states of this.preloadStates.values()) {
      const state = states.get(id);
      if (!state) continue;
      if (state.status === PluginPreloadStatus.Failed) return state;
      if (state.status === PluginPreloadStatus.Active) result = state;
      else if (!result) result = state;
    }
    return result;
  }

  private toEntry(record: PluginRecord): PluginManagerEntry {
    const { metadata, kind } = record.plugin;
    const preload = metadata.realms.preload ? this.preloadStatusFor(metadata.id) : undefined;
    const status =
      record.status === PluginStatus.Failed
        ? PluginActivationStatus.Failed
        : record.status === PluginStatus.Active && preload?.status === PluginPreloadStatus.Failed
          ? PluginActivationStatus.Partial
          : record.status === PluginStatus.Active
            ? PluginActivationStatus.Active
            : PluginActivationStatus.Inactive;
    return {
      id: metadata.id,
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      author: metadata.author,
      license: metadata.license,
      icon: metadata.icon ? pluginAssetsUrl(metadata.id, metadata.icon) : undefined,
      kind,
      enabled: this.state.isEnabled(metadata.id, kind),
      status,
      error: record.status === PluginStatus.Failed ? toError(record.error).message : undefined,
      preloadStatus:
        preload?.status ?? (metadata.realms.preload ? PluginPreloadStatus.Pending : undefined),
      preloadError: preload?.error,
    };
  }
}

function pluginAssetsUrl(id: string, assetPath: string): string {
  const encodedPath = assetPath.split("/").map(encodeURIComponent).join("/");
  return `assets://plugins/${encodeURIComponent(id)}/${encodedPath}`;
}

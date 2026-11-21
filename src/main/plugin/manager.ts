import {
  PluginActivationStatus,
  PluginPreloadStatus,
  type PluginManagerEntry,
  type PluginManagerState,
  type RealmRuntimeStatus,
} from "@shared/contracts/plugin-manager-api";
import { LOADED_REALM_IDS } from "virtual:open-orpheus/realm-runtime";
import { toError } from "@shared/util";

import { PluginStatus, type PluginLoader, type PluginRecord } from "./loader";
import type { DiscoveredPlugin } from "./discover";
import type { PluginStateStore } from "./state";

/** Combines the persisted enable intent with the loader's runtime status. */
export class PluginManager {
  private readonly realmStates = new Map<number, Map<string, Map<string, RealmRuntimeStatus>>>();

  constructor(
    private readonly loader: PluginLoader,
    private readonly state: PluginStateStore,
    /** Called after a secondary-realm plugin's enable state is persisted and applied. */
    private readonly onRealmChanged?: (id: string, realm: string, enabled: boolean) => void
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
    for (const realm of LOADED_REALM_IDS) {
      if (record.plugin.metadata.realms[realm]) {
        this.onRealmChanged?.(id, realm, enabled);
      }
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

  /** Record a secondary-realm status report from one window. */
  setRealmStatus(
    webContentsId: number,
    realm: string,
    id: string,
    status: PluginPreloadStatus,
    error?: string
  ): void {
    if (!LOADED_REALM_IDS.includes(realm)) return;
    let realms = this.realmStates.get(webContentsId);
    if (!realms) {
      realms = new Map();
      this.realmStates.set(webContentsId, realms);
    }
    let plugins = realms.get(realm);
    if (!plugins) {
      plugins = new Map();
      realms.set(realm, plugins);
    }
    plugins.set(id, { status, error });
  }

  /** Drop all secondary-realm reports when their window goes away. */
  clearRealmStatus(webContentsId: number): void {
    this.realmStates.delete(webContentsId);
  }

  private realmStatusFor(record: PluginRecord): Partial<Record<string, RealmRuntimeStatus>> {
    const result: Partial<Record<string, RealmRuntimeStatus>> = {};
    for (const realm of LOADED_REALM_IDS) {
      if (!record.plugin.metadata.realms[realm]) continue;

      let found: RealmRuntimeStatus | undefined;
      for (const states of this.realmStates.values()) {
        const state = states.get(realm)?.get(record.plugin.metadata.id);
        if (!state) continue;
        if (state.status === PluginPreloadStatus.Failed) {
          found = state;
          break;
        }
        if (state.status === PluginPreloadStatus.Active) found = state;
        else if (!found) found = state;
      }
      result[realm] = found ?? { status: PluginPreloadStatus.Pending };
    }
    return result;
  }

  private toEntry(record: PluginRecord): PluginManagerEntry {
    const { metadata, kind } = record.plugin;
    const enabled = this.state.isEnabled(metadata.id, kind);
    const realmStatus = enabled ? this.realmStatusFor(record) : undefined;
    const realmFailed = realmStatus
      ? Object.values(realmStatus).some((state) => state?.status === PluginPreloadStatus.Failed)
      : false;
    const status =
      record.status === PluginStatus.Failed
        ? PluginActivationStatus.Failed
        : record.status === PluginStatus.Active && realmFailed
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
      enabled,
      status,
      error: record.status === PluginStatus.Failed ? toError(record.error).message : undefined,
      realmStatus,
    };
  }
}

function pluginAssetsUrl(id: string, assetPath: string): string {
  const encodedPath = assetPath.split("/").map(encodeURIComponent).join("/");
  return `assets://plugins/${encodeURIComponent(id)}/${encodedPath}`;
}

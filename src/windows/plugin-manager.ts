import { contextBridge } from "electron";

import { exposeApi } from "@preload/bridge";
import { installPreloadPlugins, type PreloadRealmControl } from "@preload/plugin";
import {
  load as pluginManagerRegistry,
  realm as pluginManagerRealm,
} from "virtual:open-orpheus/registry/plugin-manager";
import { LifecycleStateKind } from "@shared/plugin/lifecycle";
import type {
  PluginConfigurationHost,
  PluginManagerHostBridge,
  PluginRealmActivationOutcome,
} from "@shared/contracts/plugin-configuration";
import { toError } from "@shared/util";

exposeApi("plugin", { platform: process.platform, versions: process.versions });

let control: PreloadRealmControl | null = null;
let configurationHost: PluginConfigurationHost | null = null;

const hostBridge: PluginManagerHostBridge = {
  setConfigurationHost(host: PluginConfigurationHost): void {
    configurationHost = host;
  },

  async waitForRealm(pluginId: string): Promise<PluginRealmActivationOutcome> {
    if (!control) return { kind: "missing" };
    await control.ready;
    const snapshot = await control.loader.waitForSnapshot(pluginId);
    if (!snapshot) return { kind: "missing" };

    switch (snapshot.state.kind) {
      case LifecycleStateKind.Running:
        return { kind: "running" };
      case LifecycleStateKind.Failed:
      case LifecycleStateKind.Hung:
      case LifecycleStateKind.Abandoned:
        return { kind: "failed", error: toError(snapshot.error).message };
      default:
        return { kind: "missing" };
    }
  },
};

contextBridge.exposeInMainWorld("pluginManagerHost", hostBridge);

void installPreloadPlugins(pluginManagerRegistry, pluginManagerRealm, {
  onControl: (next) => {
    control = next;
  },
  beforeDeactivate: (id, desired) => configurationHost?.dispose(id, desired.revision),
});

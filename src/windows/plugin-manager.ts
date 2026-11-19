import { contextBridge } from "electron";

import { exposeApi } from "@preload/bridge";
import { installPreloadPlugins } from "@preload/plugin";
import {
  load as pluginManagerRegistry,
  realm as pluginManagerRealm,
} from "virtual:open-orpheus/registry/plugin-manager";
import type { API, ManagerUIPlugin } from "@shared/plugin/realms/plugin-manager/ui";

exposeApi("plugin", { platform: process.platform, versions: process.versions });

contextBridge.executeInMainWorld({
  func: function () {
    class PluginManagerAPI extends EventTarget implements API {
      plugins: Record<string, ManagerUIPlugin> = {};

      register(id: string, plugin: ManagerUIPlugin): void {
        if (Object.prototype.hasOwnProperty.call(this.plugins, id)) {
          throw new Error(`Plugin "${id}" already registered a plugin-manager contribution`);
        }
        this.plugins[id] = plugin;
        this.dispatchEvent(new Event("changed"));
      }

      unregister(id: string): void {
        if (!(id in this.plugins)) return;
        delete this.plugins[id];
        this.dispatchEvent(new Event("changed"));
      }
    }

    (window as unknown as { pluginManager: API }).pluginManager = new PluginManagerAPI();
  },
});

void installPreloadPlugins(pluginManagerRegistry, pluginManagerRealm);

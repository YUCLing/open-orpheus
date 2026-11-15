import { exposeApi } from "@preload/bridge";
import { installPreloadPlugins } from "@preload/plugin";
import {
  load as pluginManagerRegistry,
  realm as pluginManagerRealm,
} from "virtual:open-orpheus/registry/plugin-manager";

exposeApi("plugin", { platform: process.platform, versions: process.versions });

void installPreloadPlugins(pluginManagerRegistry, pluginManagerRealm);

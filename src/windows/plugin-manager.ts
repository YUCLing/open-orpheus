import { exposeApi } from "@preload/bridge";

exposeApi("plugin", { platform: process.platform, versions: process.versions });

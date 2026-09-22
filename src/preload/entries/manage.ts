import { exposeApi } from "@bridge/preload";

exposeApi("manage", { platform: process.platform, versions: process.versions });
exposeApi("settings");

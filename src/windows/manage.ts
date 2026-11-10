import { isDiscordPresenceSupported } from "@shared/discordPresence";
import { exposeApi } from "../preload/bridge";

exposeApi("manage", {
  platform: process.platform,
  versions: process.versions,
  discordPresenceSupported: isDiscordPresenceSupported(),
});
exposeApi("settings");

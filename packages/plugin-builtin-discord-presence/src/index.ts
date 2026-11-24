import type { PluginModule, PluginRuntime } from "@open-orpheus/plugin-api";

import DiscordPresence from "./DiscordPresence";

let active: DiscordPresence | null = null;

export const activate: PluginModule["activate"] = async (runtime: PluginRuntime) => {
  const [{ playbackController }, { default: logger }] = await Promise.all([
    runtime.registry.load("@main/mediaSession"),
    runtime.registry.load("@main/logger"),
  ]);

  const presence = new DiscordPresence(
    playbackController,
    logger.child({ plugin: "discord-presence" })
  );
  active = presence;
  presence.configure(true);
};

export const deactivate: PluginModule["deactivate"] = async () => {
  const presence = active;
  active = null;
  await presence?.dispose();
};

import { registerShutdownTask } from "../lifecycle";
import { events, kv } from "../settings";
import type PlaybackController from "./PlaybackController";
import DiscordPresence from "./adapters/DiscordPresence";

export async function initializeDiscordPresence(playback: PlaybackController): Promise<void> {
  const presence = new DiscordPresence(playback);
  let changed = false;
  const unlistenChange = events.on("change", ({ data }) => {
    if (data.key !== "discordPresence.enabled") return;
    changed = true;
    presence.configure(data.value === true);
  });
  const unlistenDelete = events.on("delete", ({ data }) => {
    if (data.key !== "discordPresence.enabled") return;
    changed = true;
    presence.configure(false);
  });
  registerShutdownTask({
    name: "discord-presence",
    run: () => {
      unlistenChange();
      unlistenDelete();
      return presence.dispose();
    },
  });
  const stored = await kv.get("discordPresence.enabled");
  // 初始读取期间发生的设置更新优先，避免用旧值覆盖用户刚切换的开关。
  if (!changed) presence.configure(stored === true);
}

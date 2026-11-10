import { isDiscordPresenceSupported, type DiscordPresenceSettings } from "@shared/discordPresence";
import { registerShutdownTask } from "../lifecycle";
import { kv } from "../settings";
import type PlaybackController from "./PlaybackController";
import DiscordPresence from "./adapters/DiscordPresence";

const settingsKey = "discordPresence";
const DISCORD_APPLICATION_ID = "1569539057950658691";
let presence: DiscordPresence | undefined;

function parseSettings(value: unknown): DiscordPresenceSettings | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean"
  ) {
    return null;
  }

  return { enabled: value.enabled };
}

export async function getDiscordPresenceSettings(): Promise<DiscordPresenceSettings> {
  const value = isDiscordPresenceSupported() ? await kv.get(settingsKey) : undefined;
  return parseSettings(value) ?? { enabled: false };
}

export async function setDiscordPresenceSettings(value: unknown): Promise<boolean> {
  if (!isDiscordPresenceSupported()) return false;
  const settings = parseSettings(value);
  if (!settings || !(await kv.set(settingsKey, settings))) return false;
  presence?.configure(settings.enabled, DISCORD_APPLICATION_ID);
  return true;
}

export async function createDiscordPresence(playback: PlaybackController): Promise<void> {
  if (!isDiscordPresenceSupported()) return;
  const settings = await getDiscordPresenceSettings();
  const adapter = new DiscordPresence(playback);
  presence = adapter;
  registerShutdownTask({
    name: "discord-presence",
    run: () => {
      presence = undefined;
      return adapter.dispose();
    },
  });
  adapter.configure(settings.enabled, DISCORD_APPLICATION_ID);
}

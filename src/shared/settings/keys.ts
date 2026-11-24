/**
 * Canonical settings keys.
 *
 * The values are the persisted keys (sqlite and the settings IPC contract), so
 * renaming one is a data migration, not a rename. The `k` prefix follows
 * Chromium's constant naming (`features::kFeatureName`) and keeps every use
 * greppable.
 */
export const SETTINGS = {
  kAudioCurrentDevice: "audio.currentDevice",
  kDesktopLyricsInterpolatedLyricLine: "desktopLyrics.interpolatedLyricLine",
  kDesktopLyricsOpacity: "desktopLyrics.opacity",
  kDiscordPresenceEnabled: "discordPresence.enabled",
  kPluginsEnabled: "plugins.enabled",
  kProxy: "proxy",
  kTrayClickBehavior: "tray.clickBehavior",
  kUpdateAutoInstall: "update.autoInstall",
  kWindowLifecycle: "window.lifecycle",
  kWindowOverrideMainWindowSizeLimit: "window.overrideMainWindowSizeLimit",
} as const;

/** Every settings key this build knows about. */
export type SettingsKey = (typeof SETTINGS)[keyof typeof SETTINGS];

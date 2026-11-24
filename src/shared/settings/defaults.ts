import { SETTINGS, type SettingsKey } from "./keys";

/**
 * Defaults for every known setting.
 *
 * `undefined` means the entry has no default value; the `as T | undefined`
 * annotations keep the type the entry holds once it is set. `satisfies` (rather
 * than an annotation) keeps the key and value types available for inference.
 */
export const SETTINGS_DEFAULTS = {
  [SETTINGS.kAudioCurrentDevice]: undefined as string | undefined,
  [SETTINGS.kDesktopLyricsInterpolatedLyricLine]: true,
  [SETTINGS.kDesktopLyricsOpacity]: 1,
  [SETTINGS.kDiscordPresenceEnabled]: false,
  [SETTINGS.kPluginsEnabled]: {} as Record<string, unknown>,
  [SETTINGS.kProxy]: undefined as string | undefined,
  [SETTINGS.kTrayClickBehavior]: "always-show-menu",
  [SETTINGS.kUpdateAutoInstall]: undefined as string | undefined,
  [SETTINGS.kWindowLifecycle]: "on-demand",
  [SETTINGS.kWindowOverrideMainWindowSizeLimit]: undefined as string | undefined,
} satisfies Record<SettingsKey, unknown>;

/** Value of a setting, inferred from its default. */
type SettingsDefaultValue<K extends keyof typeof SETTINGS_DEFAULTS> = Exclude<
  (typeof SETTINGS_DEFAULTS)[K],
  undefined
>;

/**
 * Every setting this build knows about.
 *
 * The map is partial: `SETTINGS_DEFAULTS` only carries defaults, so any value
 * may be unset, and keys that are not listed here (plugins, forward
 * compatibility) can still be read and written through the store.
 */
export type Settings = {
  -readonly [K in keyof typeof SETTINGS_DEFAULTS]?: SettingsDefaultValue<K>;
};

/** Value type for a key; `unknown` for keys this build does not declare. */
export type SettingsValue<K extends string> = K extends SettingsKey ? Settings[K] : unknown;

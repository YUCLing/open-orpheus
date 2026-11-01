export type SettingsEvents = {
  change: { key: string; value: unknown };
  delete: { key: string };
};

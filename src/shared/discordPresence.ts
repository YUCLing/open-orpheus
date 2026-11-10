export interface DiscordPresenceSettings {
  enabled: boolean;
}

export function isDiscordPresenceSupported(): boolean {
  return process.platform === "linux" && !process.env.FLATPAK_ID;
}

export function isDiscordApplicationId(value: string): boolean {
  return /^[1-9]\d{16,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}

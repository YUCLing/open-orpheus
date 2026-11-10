export interface DiscordPresenceSettings {
  enabled: boolean;
  applicationId: string;
}

export function isDiscordApplicationId(value: string): boolean {
  return /^[1-9]\d{16,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}

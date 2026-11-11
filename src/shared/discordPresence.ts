export function isDiscordPresenceSupported(): boolean {
  return (
    (process.platform === "linux" ||
      process.platform === "win32" ||
      process.platform === "darwin") &&
    !process.env.FLATPAK_ID
  );
}

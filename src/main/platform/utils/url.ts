/** Whether a URL is a safe internal app URL. */
export function isAppUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "orpheus:" && hostname === "orpheus";
  } catch {
    return false;
  }
}

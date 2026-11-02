/**
 * Whether a URL safe internal app URL.
 */
export function isAppUrl(url: string | URL): boolean {
  try {
    const { protocol, hostname } = typeof url === "string" ? new URL(url) : url;
    return protocol === "orpheus:" && hostname === "orpheus";
  } catch {
    return false;
  }
}

const NCM_DOMAIN = "music.163.com";

/**
 * Whether a URL is Netease Cloud Music's.
 */
export function isNCMUrl(url: string | URL): boolean {
  try {
    const { hostname } = typeof url === "string" ? new URL(url) : url;
    // Accept the exact host and its subdomains, but not lookalikes such as
    // `evilmusic.163.com` or `music.163.com.example.com`.
    return hostname === NCM_DOMAIN || hostname.endsWith(`.${NCM_DOMAIN}`);
  } catch {
    return false;
  }
}

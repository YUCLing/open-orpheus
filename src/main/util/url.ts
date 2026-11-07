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
const SSO_DOMAINS = [NCM_DOMAIN, "qq.com", "weibo.com"] as const;

/**
 * Whether `hostname` is exactly `domain` or one of its subdomains.
 *
 * Rejects lookalikes such as `evilmusic.163.com` for `music.163.com`.
 */
export function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function getHostname(url: string | URL): string | null {
  try {
    return typeof url === "string" ? new URL(url).hostname : url.hostname;
  } catch {
    return null;
  }
}

/**
 * Whether a URL is Netease Cloud Music's.
 */
export function isNCMUrl(url: string | URL): boolean {
  const hostname = getHostname(url);
  return hostname !== null && isHostOrSubdomain(hostname, NCM_DOMAIN);
}

/**
 * Whether a URL belongs to one of the SSO hosts whose cookies the app patches
 * (Netease Cloud Music, QQ, Weibo).
 */
export function isSsoUrl(url: string | URL): boolean {
  const hostname = getHostname(url);
  return hostname !== null && SSO_DOMAINS.some((domain) => isHostOrSubdomain(hostname, domain));
}

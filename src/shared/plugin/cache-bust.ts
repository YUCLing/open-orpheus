/**
 * Append a unique `?t=<timestamp>-<rand>` query to a module URL.
 *
 * Both Node's ESM loader and Chromium's module map cache by full URL, so a
 * distinct query forces a fresh evaluation. Callers must share the returned URL
 * for one activation epoch; otherwise the same entry evaluates twice.
 */
export function cacheBustUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("t", `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  return parsed.toString();
}

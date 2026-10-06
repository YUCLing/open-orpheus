import { contextBridge, ipcRenderer } from "electron";

/**
 * Expose a typed API bridge on `window[prefix]`.
 *
 * Exposes plain-functions `_call` and `_on` (which survive contextBridge
 * cloning). The renderer-side `getBridge()` builds a typed Proxy on top.
 *
 *   window.manage.cache.getStats()
 *     → getBridge proxy catches path ["cache","getStats"]
 *     → calls raw._call("cache.getStats", ...)
 *     → ipcRenderer.invoke("manage.cache.getStats", ...)
 *
 *   window.desktopLyrics.events.lyricsUpdate(cb)
 *     → getBridge proxy catches path ["events","lyricsUpdate"]
 *     → calls raw._on("lyricsUpdate", cb)
 *     → ipcRenderer.on("desktopLyrics.lyricsUpdate", cb)
 */
export function exposeApi(prefix: string, syncValues: Record<string, unknown> = {}): void {
  contextBridge.exposeInMainWorld(prefix, {
    ...syncValues,
    _call: (channel: string, ...args: unknown[]) =>
      ipcRenderer.invoke(prefix + "." + channel, ...args),
    _on: (event: string, callback: (...args: unknown[]) => void) => {
      ipcRenderer.on(prefix + "." + event, (_event, ...data) => {
        callback(...data);
      });
    },
  });
}

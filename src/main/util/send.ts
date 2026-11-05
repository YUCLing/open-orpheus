import type { BrowserWindow, WebContents } from "electron";

type SendTarget = BrowserWindow | WebContents;

/**
 * `BrowserWindow` has a `webContents`; a `WebContents` itself does not. Keep the
 * check structural so this module stays free of a runtime Electron import,
 * which also lets unit tests exercise it without mocking Electron.
 */
function isBrowserWindow(target: SendTarget): target is BrowserWindow {
  return "webContents" in target;
}

/**
 * Send an IPC message only when its target is still alive.
 *
 * `webContents.send()` throws when either the window or its web contents has
 * been destroyed, which is easy to hit from timers, event listeners, file
 * watchers, and other callbacks that outlive the window. Check at send time so
 * a guard before an `await` cannot go stale.
 *
 * @returns `true` when the message was handed to Electron, `false` when the
 * target was missing or destroyed.
 */
export function sendIfAlive(
  target: BrowserWindow | WebContents | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!target || target.isDestroyed()) return false;

  const contents = isBrowserWindow(target) ? target.webContents : target;
  if (contents.isDestroyed()) return false;

  contents.send(channel, ...args);
  return true;
}

import type { BrowserWindow } from "electron";
import { vi } from "vitest";

/**
 * Minimal `BrowserWindow` stand-in for bridge tests that only use
 * `webContents.send`, `webContents.ipc.handle`, and the `closed` event.
 */
export function createFakeWindow() {
  const send = vi.fn();
  const handle = vi.fn();
  const on = vi.fn();
  const wnd = {
    webContents: { send, isDestroyed: () => false, ipc: { handle } },
    isDestroyed: () => false,
    on,
  } as unknown as BrowserWindow;

  return {
    wnd,
    send,
    /** Invoke a handler registered through `ipc.handle` by channel name. */
    invoke(channel: string, ...args: unknown[]) {
      const call = handle.mock.calls.find(([name]) => name === channel);
      if (!call) throw new Error(`No handler registered for ${channel}`);
      return (call[1] as (...a: unknown[]) => unknown)({}, ...args);
    },
    /** Fire the `closed` listener installed by the handler. */
    close() {
      const call = on.mock.calls.find(([name]) => name === "closed");
      if (!call) throw new Error("No closed listener registered");
      return (call[1] as () => void)();
    },
  };
}

import type { WebContents, IpcMainInvokeEvent } from "electron";

import { toDisposable, type Disposable } from "@shared/disposable";

// Only keep object branches that contain at least one function at some depth.
// Pure-data records (e.g. NodeJS.ProcessVersions) are sync values from the
// preload — they don't need ipc.handle handlers in main.
type HasFunctionDeep<T> = T extends (...args: never[]) => unknown
  ? true
  : T extends Record<string, unknown>
    ? T extends unknown[]
      ? false
      : keyof T extends never
        ? false
        : { [K in keyof T]: HasFunctionDeep<T[K]> }[keyof T]
    : false;

// Extract handler-leaves from a contract: functions become ipc.handle callbacks,
// nested objects are recursed.  Scalars, arrays, pure-data records, and the
// "events" subtree are excluded — "events" is always push-from-main
// (ipcRenderer.on), never handled.
type DeepIpcHandlers<T> = {
  [
    K in keyof T as K extends "events"
      ? never
      : T[K] extends (...args: never[]) => unknown
        ? K
        : T[K] extends Record<string, unknown>
          ? T[K] extends unknown[]
            ? never
            : HasFunctionDeep<T[K]> extends true
              ? K
              : never
          : never
  ]: T[K] extends (...args: infer A) => infer R
    ? (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>
    : T[K] extends Record<string, unknown>
      ? DeepIpcHandlers<T[K]>
      : never;
};

export function registerIpcHandlers<T>(
  wc: WebContents,
  prefix: string,
  handlers: DeepIpcHandlers<T>
): Disposable {
  const seen = new Set<string>();
  const channels: string[] = [];

  function walk(obj: Record<string, unknown>, path: string[]) {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = [...path, key];
      if (typeof value === "function") {
        const channel = currentPath.join(".");
        if (seen.has(channel)) {
          throw new Error(`Duplicate IPC channel: "${channel}"`);
        }
        seen.add(channel);
        channels.push(channel);
        wc.ipc.handle(channel, value as (...args: unknown[]) => unknown);
      } else if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        walk(value as Record<string, unknown>, currentPath);
      }
    }
  }

  walk(handlers as Record<string, unknown>, [prefix]);

  return toDisposable(() => {
    for (const channel of channels) wc.ipc.removeHandler(channel);
  });
}

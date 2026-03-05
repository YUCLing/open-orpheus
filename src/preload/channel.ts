import { contextBridge, ipcRenderer } from "electron";
import { dispatcher } from "./calls";

import "./calls/index";

const CALL_DEBUG = false; // Set to true to enable debug logs for channel.call
let _callDebugId = 0;

const nativeCallbacks = new Map<string, (...args: unknown[]) => void>();

ipcRenderer.on(
  "channel.call",
  (_event, command: string, ...args: unknown[]) => {
    fireNativeCall(command, ...args);
  }
);

export function fireNativeCall<Args extends unknown[]>(
  command: string,
  ...args: Args
) {
  if (CALL_DEBUG) {
    console.debug(`Received nativeCall: ${command} with args:`, args);
  }
  const callback = nativeCallbacks.get(command);
  callback?.(...args);
}

contextBridge.exposeInMainWorld("channel", {
  enData: (data: string) => ipcRenderer.sendSync("channel.enData", data),
  deData: (data: string) => ipcRenderer.sendSync("channel.deData", data),
  serialData: (data: [string, string | object]) =>
    ipcRenderer.sendSync("channel.serialData", ...data),
  deSerialData: (hexParams: string) =>
    ipcRenderer.sendSync("channel.deserialData", hexParams),
  encodeAnonymousId: (data: string) =>
    ipcRenderer.sendSync("channel.encodeAnonymousId", data),
  serialKey: (key: string) => ipcRenderer.sendSync("channel.serialKey", key),
  call: async (
    command: string,
    callback: (...args: unknown[]) => void,
    params: unknown[]
  ) => {
    if (CALL_DEBUG) {
      const id = _callDebugId++;
      console.debug("channel.call:", id, `${command} with params:`, ...params);
      const originalCallback = callback;
      callback = (...args) => {
        console.debug(
          "R:channel.call:",
          id,
          `for ${command} with args:`,
          ...args
        );
        originalCallback(...args);
      };
    }
    const ret = await dispatcher.dispatch(command, callback, ...params);
    if (ret === false) {
      // No handler found for the command, forward to main process
      const result = await ipcRenderer.invoke(
        "channel.call",
        command,
        ...params
      );
      if (result === false) {
        console.warn(
          `Unimplemented call command:`,
          command,
          `, params`,
          params
        );
        return;
      }
      callback.call(undefined, ...result);
    }
  },
  registerCall: (cmdEvent: string, callback: (...args: unknown[]) => void) => {
    nativeCallbacks.set(cmdEvent, callback);
  },
});

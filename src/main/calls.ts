import { IpcMainInvokeEvent } from "electron";
import CallDispatcher, {
  CallbackHandlerFunction,
  HandlerFunction,
} from "../CallDispatcher";
import logger from "./logger";

export const dispatcher = new CallDispatcher();

export function getCallLogger(namespace: string) {
  return logger.child({ name: "call", namespace });
}

export function registerCallHandler<
  Args extends unknown[],
  Return extends unknown[] | void,
>(
  cmd: string,
  handler: HandlerFunction<[IpcMainInvokeEvent, ...Args], Return>
) {
  dispatcher.registerHandler(cmd, handler);
}

export function registerCallbackHandler<Args extends unknown[]>(
  cmd: string,
  handler: CallbackHandlerFunction<[IpcMainInvokeEvent, ...Args]>
) {
  dispatcher.registerCallbackHandler(cmd, handler);
}

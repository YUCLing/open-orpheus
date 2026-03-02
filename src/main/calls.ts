import { IpcMainInvokeEvent } from "electron";
import CallDispatcher, { HandlerFunction } from "../CallDispatcher";

export const dispatcher = new CallDispatcher();

export function registerCallHandler<
  Args extends unknown[],
  Return extends unknown[] | void,
>(
  cmd: string,
  handler: HandlerFunction<[IpcMainInvokeEvent, ...Args], Return>
) {
  dispatcher.registerHandler(cmd, handler);
}

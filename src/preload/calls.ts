import CallDispatcher from "../CallDispatcher";

export const dispatcher = new CallDispatcher();

export const registerCallHandler: typeof dispatcher.registerHandler =
  dispatcher.registerHandler.bind(dispatcher);

import CallDispatcher from "@shared/CallDispatcher";

export const dispatcher = new CallDispatcher();

export const registerCallHandler: typeof dispatcher.registerHandler =
  dispatcher.registerHandler.bind(dispatcher);

export const registerCallbackHandler: typeof dispatcher.registerCallbackHandler =
  dispatcher.registerCallbackHandler.bind(dispatcher);

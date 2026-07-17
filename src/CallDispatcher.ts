export type HandlerFunction<
  Args extends unknown[] = unknown[],
  Return extends unknown[] | void = void,
> = (...args: Args) => Return | Promise<Return>;

export type CallbackHandlerFunction<Args extends unknown[] = unknown[]> = (
  callback: (...args: unknown[]) => void,
  ...args: Args
) => void | Promise<void>;

export default class CallDispatcher {
  private handlers: Record<string, HandlerFunction> = Object.create(null);
  private callbackHandlers: Record<string, CallbackHandlerFunction> =
    Object.create(null);

  registerHandler<Args extends unknown[], Return extends unknown[] | void>(
    cmd: string,
    handler: HandlerFunction<Args, Return>
  ) {
    this.handlers[cmd] = handler as unknown as HandlerFunction;
  }

  registerHandlers(handlers: { [cmd: string]: HandlerFunction }) {
    for (const [cmd, handler] of Object.entries(handlers)) {
      this.registerHandler(cmd, handler);
    }
  }

  registerCallbackHandler<Args extends unknown[]>(
    cmd: string,
    handler: CallbackHandlerFunction<Args>
  ) {
    this.callbackHandlers[cmd] = handler as CallbackHandlerFunction;
  }

  async dispatch(
    cmd: string,
    callback: (...args: unknown[]) => void,
    ...args: unknown[]
  ): Promise<void | false> {
    const callbackHandler = this.callbackHandlers[cmd];
    if (callbackHandler) {
      await callbackHandler(callback, ...args);
      return;
    }
    const handler = this.handlers[cmd];
    if (!handler) {
      return false;
    }
    const result = await handler(...args);
    callback.call(undefined, ...(Array.isArray(result) ? result : []));
  }
}

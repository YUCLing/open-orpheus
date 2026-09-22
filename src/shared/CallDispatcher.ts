export type HandlerFunction<
  Args extends unknown[] = unknown[],
  Return extends unknown[] | void = void,
> = (...args: Args) => Return | Promise<Return>;

export type CallbackHandlerFunction<Args extends unknown[] = unknown[]> = (
  callback: (...args: unknown[]) => void,
  ...args: Args
) => void | Promise<void>;

/**
 * Routes `channel.call` commands to host implementations.
 *
 * Registration here is **permanent by design** — there is deliberately no
 * `unregister`. These commands are the pack ABI (§3.1): the set the web pack is
 * compiled against, registered once during start-up and living exactly as long
 * as the process. A command that could appear and disappear would make the
 * contract depend on call history rather than on the build, and would blur the
 * "no handler" case that `dispatch` already reports as `false`. Nothing
 * acquires a resource, so nothing returns a `Disposable` (§3.3); that rule
 * applies to registrations whose lifetime is shorter than the process.
 */
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

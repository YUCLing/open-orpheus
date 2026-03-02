// TODO: Support register callback-style handlers, some native calls
// requires multiple rounds of communication.
export type HandlerFunction<
  Args extends unknown[] = unknown[],
  Return extends unknown[] | void = void,
> = (...args: Args) => Return | Promise<Return>;

export default class CallDispatcher {
  private handlers: Map<string, HandlerFunction> = new Map();

  registerHandler<Args extends unknown[], Return extends unknown[] | void>(
    cmd: string,
    handler: HandlerFunction<Args, Return>
  ) {
    this.handlers.set(cmd, handler as HandlerFunction);
  }

  registerHandlers(handlers: { [cmd: string]: HandlerFunction }) {
    for (const [cmd, handler] of Object.entries(handlers)) {
      this.registerHandler(cmd, handler);
    }
  }

  async dispatch(
    cmd: string,
    callback: (...args: unknown[]) => void,
    ...args: unknown[]
  ): Promise<unknown | false> {
    const handler = this.handlers.get(cmd);
    if (!handler) {
      return false;
    }
    const result = await handler(...args);
    callback.call(undefined, ...(Array.isArray(result) ? result : []));
  }
}

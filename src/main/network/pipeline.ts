import {
  ErrorContext,
  InterceptorState,
  NetworkExecutor,
  NetworkInterceptor,
  NetworkFetchRequest,
  NetworkFetchResponse,
  RequestContext,
  ResponseContext,
} from "./types";

export class NetworkInterceptorPipeline {
  private interceptors: NetworkInterceptor[] = [];

  use(interceptor: NetworkInterceptor): this {
    this.interceptors.push(interceptor);
    return this;
  }

  unuse(name: string): this {
    this.interceptors = this.interceptors.filter((i) => i.name !== name);
    return this;
  }

  list(): ReadonlyArray<NetworkInterceptor> {
    return this.interceptors;
  }

  async run(
    request: NetworkFetchRequest,
    state: InterceptorState,
    executor: NetworkExecutor
  ): Promise<NetworkFetchResponse> {
    // Give interceptors a private copy of the request to mutate.
    let syntheticResponse: Partial<NetworkFetchResponse> | null = null;
    // The most recent `ctx.execute()` call. The resolve phase awaits this
    // instead of issuing the request a second time; a synthetic response set
    // by any interceptor still takes precedence over it.
    const execution: { promise: Promise<Partial<NetworkFetchResponse>> | null } = { promise: null };
    const ctx: RequestContext = {
      request: { ...request, headers: { ...request.headers } },
      state,
      execute: (req: NetworkFetchRequest = ctx.request) => {
        const promise = executor(req, state);
        execution.promise = promise;
        return promise;
      },
      respondWith: (response: Partial<NetworkFetchResponse> | null) => {
        syntheticResponse = response;
      },
    };

    // Only interceptors whose onRequest ran get onResponse / onError.
    const active: NetworkInterceptor[] = [];

    try {
      // ---- request phase ----
      for (const interceptor of this.interceptors) {
        active.push(interceptor);
        await interceptor.onRequest?.(ctx);
        if (syntheticResponse) {
          LOGGER.debug(
            { interceptor: interceptor.name },
            "Interceptor responded with synthetic response"
          );
          break;
        }
      }

      // ---- resolve ----
      const partial =
        syntheticResponse ??
        (execution.promise ? await execution.promise : await executor(ctx.request, state));

      const response: NetworkFetchResponse = {
        code: 0,
        error: "",
        blob: "",
        headers: {},
        status: 0,
        retryTimes: 0,
        ...partial,
        // state is authoritative for counters
        globalSucCount: state.stats.globalSucCount,
        globalFailCount: state.stats.globalFailCount,
      };

      // ---- response phase ----
      const responseCtx: ResponseContext = {
        request: ctx.request,
        state,
        response,
        synthetic: syntheticResponse !== null,
      };
      for (const interceptor of active) {
        await interceptor.onResponse?.(responseCtx);
      }

      return response;
    } catch (error) {
      // ---- error phase (reverse order) ----
      const errorCtx: ErrorContext = { request: ctx.request, state, error };
      for (const interceptor of [...active].reverse()) {
        try {
          await interceptor.onError?.(errorCtx);
        } catch (hookError) {
          LOGGER.warn({ interceptor: interceptor.name, hookError }, "onError hook failed");
        }
      }
      throw error;
    }
  }
}

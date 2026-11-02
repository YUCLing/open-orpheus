export interface NetworkFetchRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  isDecrypt?: boolean;
  /**
   * How many retries the network client may perform after the first attempt.
   * `0` disables retries; omit it to use the default.
   *
   * The client only retries idempotent methods (GET, HEAD, …): `POST` requests
   * are never retried, so this field has no effect on them.
   */
  retryCount?: number;
  [key: string]: unknown; // extension point
}

export interface NetworkFetchResponse {
  code: number;
  error: string;
  blob: string;
  headers: Record<string, string>;
  status: number;
  retryTimes: number;
  globalSucCount: number;
  globalFailCount: number;
}

export interface GlobalStats {
  globalSucCount: number;
  globalFailCount: number;
}

export interface InterceptorState {
  stats: GlobalStats; // shared mutable counters
  tags: Record<string, unknown>; // interceptor → interceptor scratch space
}

export interface RequestContext {
  request: NetworkFetchRequest;
  state: InterceptorState;
  /**
   * Perform the request now, bypassing the rest of the request pipeline.
   *
   * The pipeline reuses the most recent execution as its response instead of
   * running the request a second time, unless a `respondWith` response is set
   * (a later `respondWith` overrides it). Only the last call is reused; earlier
   * executions are not cancelled.
   *
   * Catching a rejection here does not make the request succeed: the pipeline
   * still fails unless `respondWith` provides a fallback response.
   */
  execute(this: void, req?: NetworkFetchRequest): Promise<Partial<NetworkFetchResponse>>;
  /** Respond with a synthetic response; the pipeline stops running further interceptors. */
  respondWith(this: void, response: Partial<NetworkFetchResponse>): void;
}

export interface ResponseContext {
  request: NetworkFetchRequest;
  state: InterceptorState;
  response: NetworkFetchResponse; // fully merged, mutable
  synthetic: boolean;
}

export interface ErrorContext {
  request: NetworkFetchRequest;
  state: InterceptorState;
  error: unknown;
}

export interface NetworkInterceptor {
  name: string;
  onRequest?(ctx: RequestContext): Promise<void> | void;
  onResponse?(ctx: ResponseContext): Promise<void> | void;
  onError?(ctx: ErrorContext): Promise<void> | void;
}

export type NetworkExecutor = (
  request: NetworkFetchRequest,
  state: InterceptorState
) => Promise<Partial<NetworkFetchResponse>>;

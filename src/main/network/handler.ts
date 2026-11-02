import { deserialData } from "@main/crypto";
import { client } from "@main/request";

import type { InterceptorState, NetworkFetchRequest, NetworkFetchResponse } from "./types";

export const DEFAULT_RETRY_COUNT = 1;
const RETRY_BACKOFF_LIMIT_MS = 10_000;

export async function executeNetworkRequest(
  request: NetworkFetchRequest,
  state: InterceptorState
): Promise<Partial<NetworkFetchResponse>> {
  const retryLimit = request.retryCount ?? DEFAULT_RETRY_COUNT;

  const response = await client(request.url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body || undefined,
    throwHttpErrors: false,
    retry: { limit: retryLimit, backoffLimit: RETRY_BACKOFF_LIMIT_MS },
    hooks: {
      beforeRetry: [
        () => {
          state.stats.globalFailCount++;
        },
      ],
    },
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (value !== undefined) headers[key] = value;
  }

  const responseBody = Buffer.from(response.rawBody);
  const blob = request.isDecrypt
    ? deserialData(
        responseBody.buffer.slice(
          responseBody.byteOffset,
          responseBody.byteOffset + responseBody.byteLength
        )
      )
    : responseBody.toString();

  state.stats.globalSucCount++;

  // This is the value the client has always received (`retryCount - retries
  // used - 1`); clamp it so a single-shot request cannot report a negative.
  const retryTimes = Math.max(0, retryLimit - response.retryCount - 1);
  LOGGER.debug({ status: response.statusCode, retryTimes }, "Network request finished");

  return { blob, headers, status: response.statusCode, retryTimes };
}

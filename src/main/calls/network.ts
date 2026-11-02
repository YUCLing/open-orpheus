import dns from "node:dns";

import { RequestError } from "got";

import { registerCallHandler } from "../calls";
import { AegisEncryptState, XeapiAegis, type AegisInitConfig } from "../xeapi";
import { toError } from "@shared/util";
import {
  GlobalStats,
  InterceptorState,
  NetworkFetchRequest,
  NetworkFetchResponse,
} from "@main/network/types";
import { DEFAULT_RETRY_COUNT, executeNetworkRequest } from "@main/network/handler";
import { networkInterceptorPipeline } from "@main/network/interceptor";

const globalStats: GlobalStats = { globalSucCount: 0, globalFailCount: 0 };
const aegis = new XeapiAegis();

registerCallHandler<[NetworkFetchRequest], [NetworkFetchResponse]>(
  "network.fetch",
  async (_, request): Promise<[NetworkFetchResponse]> => {
    const state: InterceptorState = {
      stats: globalStats,
      tags: {},
    };

    try {
      const response = await networkInterceptorPipeline.run(request, state, executeNetworkRequest);
      return [response];
    } catch (error) {
      // Count the terminal failure once, in addition to the retries already
      // recorded by the executor's `beforeRetry` hook. Without this, errors
      // that `got` does not retry (invalid URL, TLS/agent failures) would not
      // be counted at all.
      state.stats.globalFailCount++;

      const retryLimit = request.retryCount ?? DEFAULT_RETRY_COUNT;
      const retryTimes =
        error instanceof RequestError && error.request
          ? Math.max(0, retryLimit - error.request.retryCount - 1)
          : 0;
      LOGGER.debug({ method: request.method, retryTimes }, "Network request failed");

      return [
        {
          code: 28,
          error:
            typeof error === "string"
              ? error
              : error instanceof Error
                ? error.message
                : (JSON.stringify(error) ?? "Unknown error"),
          status: 0,
          blob: "",
          headers: {},
          retryTimes,
          globalSucCount: state.stats.globalSucCount,
          globalFailCount: state.stats.globalFailCount,
        },
      ];
    }
  }
);

registerCallHandler<
  [],
  [
    {
      dnsInvalid: boolean;
      firstDNS: string;
      inProxy: boolean;
      restricted: boolean;
      unreachable: boolean;
    },
  ]
>("network.getEnv", () => [
  {
    dnsInvalid: false,
    firstDNS: dns.getServers()[0] || "",
    inProxy: false,
    restricted: false,
    unreachable: false,
  },
]);

registerCallHandler<[AegisInitConfig], [{ errorCode: number }]>(
  "network.initAegis",
  (event, config) => [
    aegis.init(config ?? {}, {
      onEncryptStateChange: (state: AegisEncryptState, reason: string) => {
        event.sender.send("channel.call", "network.onEncryptStateChange", state, reason);
      },
      onRequestPublicKey: (request) => {
        event.sender.send(
          "channel.call",
          "network.onRequestAegisPublicKey",
          request.currentKeyVersion,
          request.requestType,
          request.signature,
          request.timestamp,
          request.nonce
        );
      },
    }),
  ]
);

registerCallHandler<[{ body?: string }], [{ encryptedBody: string }]>(
  "network.aegisEncrypt",
  (_, request) => {
    const body = request?.body ?? "";
    try {
      return [{ encryptedBody: aegis.encrypt(body) }];
    } catch (error) {
      LOGGER.warn({ err: toError(error) }, "Aegis encryption failed, sending plain body");
      return [{ encryptedBody: body }];
    }
  }
);

registerCallHandler<[{ sessionId?: string; sessionKey?: string }], void>(
  "network.setSession",
  (_, session) => {
    aegis.setSession(session?.sessionId ?? "", session?.sessionKey ?? "");
  }
);

registerCallHandler<[{ response?: string }], void>(
  "network.updateAegisPublicKey",
  (_, response) => {
    aegis.updatePublicKeyResponse(response?.response ?? "");
  }
);

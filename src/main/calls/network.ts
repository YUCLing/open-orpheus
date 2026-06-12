import dns from "node:dns";

import { RequestError } from "got";
import type { Method } from "got";

import { registerCallHandler } from "../calls";
import { deserialData } from "../crypto";
import { client } from "../request";
import interceptAnonymousRequest from "../anonymous";
import { AegisEncryptState, XeapiAegis, type AegisInitConfig } from "../xeapi";

let globalFailCount = 0;
let globalSucCount = 0;
const aegis = new XeapiAegis();

export type NetworkFetchRequest = {
  url: string;
  method: Method;
  headers: Record<string, string>;
  body: string;
  retryCount: number;
  isDecrypt?: boolean;
};

export type NetworkFetchResponse = {
  code: number;
  error: string;
} & Partial<{
  globalFailCount: number;
  globalSucCount: number;
  headers: Record<string, string>;
  retryTimes: number;
  status: number;
  blob: string;
}>;

registerCallHandler<[NetworkFetchRequest], [NetworkFetchResponse]>(
  "network.fetch",
  async (_, request): Promise<[NetworkFetchResponse]> => {
    const retryCount = request.retryCount ?? 1;

    try {
      const anonymousRes = await interceptAnonymousRequest(request);
      if (anonymousRes !== null) {
        const [res, suc, fail] = anonymousRes;
        globalSucCount += suc;
        globalFailCount += fail;
        if (res instanceof Error) throw res;
        return [
          {
            code: 0,
            error: "",
            globalFailCount,
            globalSucCount,
            ...res,
          },
        ];
      }

      const response = await client(request.url, {
        method: request.method,
        headers: {
          ...request.headers,
        },
        body: request.body || undefined,
        throwHttpErrors: false,
        retry: {
          limit: retryCount,
          backoffLimit: 10000,
        },
        hooks: {
          beforeRetry: [
            () => {
              globalFailCount++;
            },
          ],
        },
      });

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          headers[key] = value.join(", ");
        } else if (value !== undefined) {
          headers[key] = value;
        }
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

      globalSucCount++;

      return [
        {
          code: 0,
          blob,
          error: "",
          globalFailCount,
          globalSucCount,
          headers,
          retryTimes: retryCount - response.retryCount - 1,
          status: response.statusCode,
        },
      ];
    } catch (error) {
      globalFailCount++;
      const retryTimes =
        error instanceof RequestError && error.request
          ? retryCount - error.request.retryCount - 1
          : 0;

      return [
        {
          code: 28,
          error:
            (error as Error)?.message ||
            (error ? String(error) : "Unknown error"),
          status: 0,
          blob: "",
          headers: {},
          retryTimes,
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
        event.sender.send(
          "channel.call",
          "network.onEncryptStateChange",
          state,
          reason
        );
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
    } catch {
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

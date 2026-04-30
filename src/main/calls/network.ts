import dns from "node:dns";

import { RequestError } from "got";
import type { Method } from "got";

import { registerCallHandler } from "../calls";
import { deserialData, tryDeserialData } from "../crypto";
import { broadcastListenTogetherPlayCommand } from "../nim";
import { extractListenTogetherCommandInfo } from "../../shared/listenTogetherCommand";
import { isRecord } from "../../shared/utils";
import client from "../request";

let globalFailCount = 0;
let globalSucCount = 0;

type NetworkFetchResponse = {
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

function parseFormBody(body: string) {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function tryParseJsonObject(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractCommandInfoFromRequestBody(body: string) {
  const direct = parseFormBody(body);
  const eapiPlainText = direct.params ? tryDeserialData(direct.params) : null;
  const form = eapiPlainText ? parseFormBody(eapiPlainText) : direct;
  const commandInfo = tryParseJsonObject(form.commandInfo);
  if (!commandInfo) return null;
  return extractListenTogetherCommandInfo(commandInfo);
}

registerCallHandler<
  [
    {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
      retryCount: number;
      isDecrypt?: boolean;
    },
  ],
  [NetworkFetchResponse]
>("network.fetch", async (_, request): Promise<[NetworkFetchResponse]> => {
  const retryCount = request.retryCount ?? 1;
  const shouldBroadcastPlayCommand = request.url.includes(
    "/api/listen/together/play/command/report"
  );
  const listenTogetherCommandInfo = shouldBroadcastPlayCommand
    ? extractCommandInfoFromRequestBody(request.body || "")
    : null;

  if (shouldBroadcastPlayCommand) {
    console.log("[LT:NET] intercepted listen-together API, commandInfo:", listenTogetherCommandInfo ? JSON.stringify(listenTogetherCommandInfo).slice(0, 200) : "null");
  }

  try {
    const response = await client(request.url, {
      method: request.method as Method,
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

    if (
      shouldBroadcastPlayCommand &&
      response.statusCode >= 200 &&
      response.statusCode < 300 &&
      listenTogetherCommandInfo
    ) {
      let apiSuccess = false;
      try {
        const parsed = JSON.parse(blob);
        apiSuccess = isRecord(parsed) && parsed.code === 200;
      } catch { /* non-JSON response */ }

      if (apiSuccess) {
        broadcastListenTogetherPlayCommand(listenTogetherCommandInfo);
      } else {
        console.warn("[LT:NET] API response not success, skipping broadcast");
      }
    }

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
});

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

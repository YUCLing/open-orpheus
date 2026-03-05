import dns from "node:dns";

import { stringifyCookie } from "cookie";
import { registerCallHandler } from "../calls";
import { getCookies, processSetCookie } from "../cookie";
import { deserialData } from "../crypto";

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
  let lastError: unknown;
  let lastAttempt = 0;

  for (let attempt = 0; attempt <= request.retryCount; attempt++) {
    try {
      // Exponential backoff: wait before retrying (skip on first attempt)
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Max 10 seconds
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const response = await fetch(request.url, {
        method: request.method,
        headers: {
          ...request.headers,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.28.205001",
          Cookie: stringifyCookie(getCookies(request.url)),
        },
        body: request.body,
      });

      const headers: Record<string, string> = {};
      const setCookieHeaders: string[] = [];
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") {
          setCookieHeaders.push(value);
        }
        headers[key] = value;
      });

      processSetCookie(request.url, setCookieHeaders);

      let blob: string;
      if (request.isDecrypt) {
        const arrayBuffer = await response.arrayBuffer();
        blob = deserialData(arrayBuffer);
      } else {
        blob = await response.text();
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
          retryTimes: request.retryCount - attempt - 1,
          status: response.status,
        },
      ];
    } catch (error) {
      globalFailCount++;
      lastError = error;
      lastAttempt = attempt;
      // Continue to next retry attempt
    }
  }

  // All retries exhausted
  return [
    {
      code: 1,
      error:
        (lastError as Error)?.message || "Network request failed after retries",
      retryTimes: request.retryCount - lastAttempt - 1,
    },
  ];
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

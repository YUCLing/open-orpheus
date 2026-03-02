import { ipcRenderer } from "electron";
import { registerCallHandler } from "../calls";

// TODO: Implement this properly?
registerCallHandler<
  [],
  [
    {
      maxFailCount: number;
      nativeReportPercent: number;
      normalReportPercent: number;
      supportRPC: boolean;
    },
  ]
>("network.init", () => [
  {
    maxFailCount: 40,
    nativeReportPercent: 0,
    normalReportPercent: 0,
    supportRPC: true,
  },
]);

// TODO: Implement retry logic
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
  [
    {
      code: number;
      error: string;
    } & Partial<{
      globalFailCount: number;
      globalSucCount: number;
      headers: Record<string, string>;
      retryTimes: number;
      status: number;
    }>,
  ]
>("network.fetch", async (request) => {
  return [
    await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    })
      .then(async (response) => {
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        let blob: string;
        if (request.isDecrypt) {
          const arrayBuffer = await response.arrayBuffer();
          blob = ipcRenderer.sendSync("channel.deserialData", arrayBuffer);
        } else {
          blob = await response.text();
        }
        return {
          status: response.status,
          blob,
          headers,
        };
      })
      .then(({ status, blob, headers }) => {
        return {
          code: 0,
          blob,
          error: "",
          globalFailCount: 0,
          globalSucCount: 0,
          headers,
          retryTimes: 1,
          status,
        };
      })
      .catch((error) => {
        return { code: 1, error: error.message };
      }),
  ];
});

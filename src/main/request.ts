import type { AgentOptions } from "node:http";
import tls from "node:tls";

import { parseSetCookie, stringifyCookie } from "cookie";
import got, { type Agents, type Got } from "got";
import { session } from "electron";

import { getCookies, setCookie } from "./cookie";

export type ProxyTypes = "none" | "ie" | "http" | "socks4" | "socks5";

export type ProxyServer = {
  Host: string;
  Port: string;
  UserName: string;
  Password: string;
};

export type ProxyConfiguration = {
  Type: ProxyTypes;
} & Partial<Record<ProxyTypes, ProxyServer>>;

const defaultHttpAgentOptions: AgentOptions = {
  keepAlive: true,
};

export function getProxyURL(proto: string, server: ProxyServer): URL {
  const url = new URL(`${proto}://${server.Host}:${server.Port}`);
  if (server.UserName || server.Password) {
    url.username = server.UserName;
    url.password = server.Password;
  }
  return url;
}

export async function getProxyAgent(
  config?: ProxyConfiguration
): Promise<Agents | undefined> {
  if (!config) return undefined;
  switch (config.Type) {
    case "none":
      return undefined;
    case "ie": {
      const ProxyAgent = (await import("proxy-agent")).ProxyAgent;
      const agent = new ProxyAgent(defaultHttpAgentOptions);
      return {
        http: agent,
        https: agent,
        http2: undefined,
      };
    }
    case "http": {
      const HttpProxyAgent = (await import("http-proxy-agent")).HttpProxyAgent;
      const HttpsProxyAgent = (await import("https-proxy-agent"))
        .HttpsProxyAgent;
      const cfg = config[config.Type]!;
      const httpAgent = new HttpProxyAgent(
        getProxyURL(config.Type, cfg),
        defaultHttpAgentOptions
      );
      const httpsAgent = new HttpsProxyAgent(
        getProxyURL(config.Type, cfg),
        defaultHttpAgentOptions
      );
      return {
        http: httpAgent,
        https: httpsAgent,
        http2: undefined,
      };
    }
    case "socks4":
    case "socks5": {
      const SocksProxyAgent = (await import("socks-proxy-agent"))
        .SocksProxyAgent;
      const cfg = config[config.Type]!;
      const agent = new SocksProxyAgent(
        getProxyURL(config.Type, cfg),
        defaultHttpAgentOptions
      );
      return {
        http: agent,
        https: agent,
        http2: undefined,
      };
    }
  }
}

let client: Got = got.extend({
  headers: {
    // We get User-Agent from Electron, so make sure this module is only imported after app ready.
    "User-Agent": session.defaultSession.getUserAgent(),
    Origin: "orpheus://orpheus",
  },
  cookieJar: {
    getCookieString: async (url: string) => {
      return stringifyCookie(await getCookies(url));
    },
    setCookie: async (rawCookie: string, url: string) => {
      await setCookie(url, parseSetCookie(rawCookie));
    },
  },
  https: {
    certificateAuthority: [
      ...tls.getCACertificates("system"),
      ...tls.rootCertificates,
    ],
  },
});

export default client;

export function setProxy(agents: Agents | undefined) {
  client = client.extend({
    agent: agents,
  });
}

export function setupRequestInterceptors() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    async (details, callback) => {
      const url = new URL(details.url);

      // Generic Cookie Injection
      if (url.protocol === "https:" && url.hostname.endsWith("music.163.com")) {
        const cookies = stringifyCookie(
          await getCookies("https://" + url.hostname)
        );
        details.requestHeaders["Cookie"] = cookies;
      }

      callback({ requestHeaders: details.requestHeaders });
    }
  );

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    // weibo: redirect to https
    if (url.startsWith("http://music.163.com/back/")) {
      return callback({ redirectURL: url.replace("http://", "https://") });
    }
    // wechat: add self_redirect=true
    if (url.includes("/qrconnect") && !url.includes("self_redirect=")) {
      const separator = url.includes("?") ? "&" : "?";
      return callback({ redirectURL: `${url}${separator}self_redirect=true` });
    }
    callback({});
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    details.responseHeaders = details.responseHeaders ?? {};

    // SSO login: add SameSite=None; Secure
    // only iframe
    if (details.frame !== null && details.frame?.top !== details.frame) {
      const host = new URL(details.url).hostname;
      if (
        host.endsWith("music.163.com") ||
        host.endsWith("qq.com") ||
        host.endsWith("weibo.com")
      ) {
        const cookieKey = Object.keys(details.responseHeaders).find(
          (k) => k.toLowerCase() === "set-cookie"
        );
        if (cookieKey && details.responseHeaders[cookieKey]) {
          details.responseHeaders[cookieKey] = (
            details.responseHeaders[cookieKey] as string[]
          ).map((c) => {
            let patched = c;
            if (!patched.toLowerCase().includes("samesite"))
              patched += "; SameSite=None";
            if (!patched.toLowerCase().includes("secure"))
              patched += "; Secure";
            return patched;
          });
        }
      }
    }

    // Custom skin
    if (details.url.startsWith("https://music.163.com/api/nos/token/alloc")) {
      details.responseHeaders["Access-Control-Allow-Origin"] = [
        "orpheus://orpheus",
      ];
      details.responseHeaders["Access-Control-Allow-Credentials"] = ["true"];
    }

    callback({ responseHeaders: details.responseHeaders });
  });
}

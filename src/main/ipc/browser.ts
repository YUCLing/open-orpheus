import { registerCallHandler } from "./dispatcher";

export interface BrowserDeps {
  cookie: {
    getCookies: typeof import("../platform/cookie").getCookies;
    getFullCookies: typeof import("../platform/cookie").getFullCookies;
    removeCookie: typeof import("../platform/cookie").removeCookie;
    setCookie: typeof import("../platform/cookie").setCookie;
  };
}

type SetCookie = {
  Domain: string;
  Name: string;
  Value: string;
  Path?: string;
  Url: string;
  Creation?: number;
  Expires?: number;
  HasExpires?: 0 | 1;
  Httponly?: 0 | 1;
  LastAccess?: number;
  Secure?: 0 | 1;
  ["max-age"]?: number;
  samesite?: "strict";
};

type FullCookie = {
  Creation: number;
  Domain: string;
  Expires: number;
  HasExpires: 0 | 1;
  Httponly: number;
  LastAccess: number;
  Name: string;
  Path: string;
  Secure: number;
  Url: string;
  Value: string;
};

export function register(deps: BrowserDeps): void {
  registerCallHandler<[string], [FullCookie[]]>(
    "browser.getFullCookies",
    async (_, url) => {
      // TODO: We might need to know when the cookie was actually created/last accessed and what's the original URL.
      return [
        (await deps.cookie.getFullCookies(url)).map((cookie) => ({
          Creation: Date.now() / 1000,
          Domain: cookie.domain || "",
          Expires: cookie.expirationDate || Date.now() / 1000,
          HasExpires: cookie.expirationDate !== undefined ? 1 : 0,
          Httponly: cookie.httpOnly ? 1 : 0,
          LastAccess: Date.now() / 1000,
          Name: cookie.name,
          Path: cookie.path || "/",
          Secure: cookie.secure ? 1 : 0,
          Url: `${cookie.secure ? "https:" : "http:"}//${cookie.domain}${cookie.path}`,
          Value: cookie.value,
        })),
      ];
    }
  );

  registerCallHandler<[string], [Record<string, string>]>(
    "browser.getCookies",
    async (_, url) => {
      return [await deps.cookie.getCookies(url)];
    }
  );

  registerCallHandler<[SetCookie], [boolean]>(
    "browser.setCookie",
    async (_, cookie) => {
      try {
        const url = new URL(cookie.Url);
        const targetDomain = cookie.Domain.startsWith(".")
          ? cookie.Domain.slice(1)
          : cookie.Domain;
        if (url.hostname !== targetDomain) {
          // We expect this API can set the cookie no matter the URL's hostname, so we override it,
          // otherwise Electron will reject it.
          url.hostname = targetDomain;
        }
        await deps.cookie.setCookie(url.toString(), {
          name: cookie.Name,
          value: cookie.Value,
          domain: cookie.Domain,
          path: cookie.Path,
          httpOnly:
            cookie.Httponly !== undefined ? cookie.Httponly === 1 : undefined,
          expires:
            cookie.HasExpires && cookie.Expires
              ? new Date(cookie.Expires * 1000)
              : undefined,
          secure: cookie.Secure !== undefined ? cookie.Secure === 1 : undefined,
          maxAge: cookie["max-age"],
          sameSite: cookie.samesite,
        });
      } catch (error) {
        LOGGER.error(
          { cookie: cookie.Name, err: error },
          "Failed to set cookie: %s"
        );
        return [false];
      }
      return [true];
    }
  );

  registerCallHandler<[string, string], [number]>(
    "browser.removeCookie",
    async (_, url, name) => {
      const hasCookie = (await deps.cookie.getCookies(url))[name] !== undefined;
      if (!hasCookie) {
        return [0];
      }
      await deps.cookie.removeCookie(url, name);
      return [1];
    }
  );
}

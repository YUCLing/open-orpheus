import { registerCallHandler } from "../calls";
import { getCookies, getFullCookies, removeCookie, setCookie } from "../cookie";

type SetCookie = {
  Domain: string;
  Name: string;
  Value: string;
  Path?: string;
  Url: string;
};

type FullCookie = {
  Creation: number;
  Domain: string;
  Expires: number;
  HasExpires: number;
  Httponly: number;
  LastAccess: number;
  Name: string;
  Path: string;
  Secure: number;
  Url: string;
  Value: string;
};
registerCallHandler<[string], FullCookie[]>(
  "browser.getFullCookies",
  async (_, url) => {
    return getFullCookies(url).map((cookie) => ({
      Creation: cookie.createdAt,
      Domain: cookie.domain,
      Expires: cookie.expires?.valueOf(),
      HasExpires: cookie.expires !== undefined ? 1 : 0,
      Httponly: cookie.httpOnly ? 1 : 0,
      LastAccess: cookie.lastAccessed,
      Name: cookie.name,
      Path: cookie.path,
      Secure: cookie.secure ? 1 : 0,
      Url: `${cookie.secure ? "https:" : "http:"}//${cookie.domain}${cookie.path}`,
      Value: cookie.value,
    }));
  }
);

registerCallHandler<[string], [Record<string, string>]>(
  "browser.getCookies",
  async (_, url) => {
    return [getCookies(url)];
  }
);

registerCallHandler<[SetCookie], [boolean]>(
  "browser.setCookie",
  async (_, cookie) => {
    try {
      setCookie({
        name: cookie.Name,
        value: cookie.Value,
        domain: cookie.Domain,
        path: cookie.Path,
      });
    } catch (error) {
      console.error(`Error setting cookie: ${error.message}`);
      return [false];
    }
    return [true];
  }
);

registerCallHandler<[string, string], [number]>(
  "browser.removeCookie",
  async (_, url, name) => {
    return [removeCookie(url, name)];
  }
);

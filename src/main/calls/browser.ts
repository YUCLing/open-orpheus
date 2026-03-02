import { registerCallHandler } from "../calls";

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
  async (url) => {
    // TODO: Implement this properly
    console.warn("browser.getCookies: Returning no cookies for", url);
    return [];
  }
);

registerCallHandler<[string], [Record<string, string>]>(
  "browser.getCookies",
  async (url) => {
    // TODO: Implement this properly
    console.warn("browser.getCookies: Returning no cookies for", url);
    return [{}];
  }
);

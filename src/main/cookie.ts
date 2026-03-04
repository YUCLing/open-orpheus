import { ipcMain } from "electron";
import * as cookie from "cookie";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deData, enData } from "./crypto";
import { data } from "./folders";

type StoredCookie = cookie.SetCookie & {
  hostOnly?: boolean;
  createdAt?: number;
  expiresAt?: number;
  lastAccessed?: number;
};

let cookies: StoredCookie[] = [];

function normalizeDomain(input: string) {
  return input.trim().toLowerCase().replace(/^\.+/, "");
}

function domainMatch(hostname: string, cookieDomain: string) {
  if (hostname === cookieDomain) {
    return true;
  }
  return hostname.endsWith(`.${cookieDomain}`);
}

function pathMatch(requestPath: string, cookiePath: string) {
  if (requestPath === cookiePath) {
    return true;
  }
  if (!requestPath.startsWith(cookiePath)) {
    return false;
  }
  if (cookiePath.endsWith("/")) {
    return true;
  }
  return requestPath[cookiePath.length] === "/";
}

function getExpiresAt(cookieValue: StoredCookie) {
  if (typeof cookieValue.maxAge === "number") {
    if (typeof cookieValue.createdAt !== "number") {
      return cookieValue.maxAge <= 0 ? 0 : undefined;
    }
    return cookieValue.createdAt + cookieValue.maxAge * 1000;
  }
  if (typeof cookieValue.expiresAt === "number") {
    return cookieValue.expiresAt;
  }
  if (cookieValue.expires instanceof Date) {
    return cookieValue.expires.getTime();
  }
  return undefined;
}

function isExpired(cookieValue: StoredCookie, now = Date.now()) {
  const expiresAt = getExpiresAt(cookieValue);
  return typeof expiresAt === "number" && expiresAt <= now;
}

function removeExpiredCookies() {
  const now = Date.now();
  const before = cookies.length;
  cookies = cookies.filter((cookieValue) => !isExpired(cookieValue, now));
  if (cookies.length !== before) {
    void saveToFile(join(data, "cookies.dat"));
  }
}

function normalizeLoadedCookie(rawCookie: StoredCookie): StoredCookie {
  const normalizedCookie = { ...rawCookie };
  if (normalizedCookie.domain) {
    normalizedCookie.domain = normalizeDomain(normalizedCookie.domain);
  }
  if (!normalizedCookie.path || !normalizedCookie.path.startsWith("/")) {
    normalizedCookie.path = "/";
  }
  if (normalizedCookie.expires && !(normalizedCookie.expires instanceof Date)) {
    const parsedExpires = new Date(normalizedCookie.expires as unknown as string);
    if (!Number.isNaN(parsedExpires.getTime())) {
      normalizedCookie.expires = parsedExpires;
    } else {
      delete normalizedCookie.expires;
    }
  }
  if (typeof normalizedCookie.expiresAt !== "number") {
    const expiresAt = getExpiresAt(normalizedCookie);
    if (typeof expiresAt === "number") {
      normalizedCookie.expiresAt = expiresAt;
    }
  }
  if (typeof normalizedCookie.lastAccessed !== "number") {
    normalizedCookie.lastAccessed = normalizedCookie.createdAt;
  }
  return normalizedCookie;
}

function getMatchingCookies(url: string) {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return [];
  }

  removeExpiredCookies();

  const hostname = parsedUrl.hostname.toLowerCase();
  const requestPath = parsedUrl.pathname || "/";
  const isSecureRequest = parsedUrl.protocol === "https:";

  const matchedCookies = cookies
    .filter((cookieValue) => {
      if (cookieValue.secure && !isSecureRequest) {
        return false;
      }
      if (!cookieValue.domain) {
        return false;
      }
      const cookieDomain = normalizeDomain(cookieValue.domain);
      if (cookieValue.hostOnly) {
        if (hostname !== cookieDomain) {
          return false;
        }
      } else if (!domainMatch(hostname, cookieDomain)) {
        return false;
      }
      const cookiePath = cookieValue.path || "/";
      return pathMatch(requestPath, cookiePath);
    })
    .sort((a, b) => {
      const pathLengthDelta = (b.path?.length || 1) - (a.path?.length || 1);
      if (pathLengthDelta !== 0) {
        return pathLengthDelta;
      }
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

  if (matchedCookies.length > 0) {
    const now = Date.now();
    for (const cookieValue of matchedCookies) {
      cookieValue.lastAccessed = now;
    }
    void saveToFile(join(data, "cookies.dat"));
  }

  return matchedCookies;
}

function parseProcessSetCookieArgs(
  firstArg: string | string[],
  secondArg?: string[]
): { requestUrl?: string; setCookieHeaders: string[] } {
  if (Array.isArray(firstArg)) {
    return { setCookieHeaders: firstArg };
  }
  return { requestUrl: firstArg, setCookieHeaders: secondArg || [] };
}

export async function loadFromFile(path: string) {
  if (!existsSync(path)) {
    return;
  }
  try {
    const loadedCookies = JSON.parse(
      deData(await readFile(path)).toString("utf-8")
    ) as StoredCookie[];
    cookies = loadedCookies.map(normalizeLoadedCookie);
    removeExpiredCookies();
  } catch (error) {
    console.error("Failed to load cookies from file:", error);
  }
}

export async function saveToFile(path: string) {
  try {
    const data = Buffer.from(enData(JSON.stringify(cookies)), "base64");
    await writeFile(path, data);
  } catch (error) {
    console.error("Failed to save cookies to file:", error);
  }
}

export function getFullCookies(url: string) {
  return getMatchingCookies(url);
}

export function getCookies(url: string) {
  return Object.fromEntries(
    getMatchingCookies(url)
      .filter((cookieValue) => cookieValue.value !== undefined)
      .map((cookieValue) => [cookieValue.name, cookieValue.value])
  );
}

export function removeCookie(url: string, name: string) {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const requestPath = parsedUrl.pathname || "/";

  const before = cookies.length;
  cookies = cookies.filter((cookieValue) => {
    if (cookieValue.name !== name || !cookieValue.domain) {
      return true;
    }

    const cookieDomain = normalizeDomain(cookieValue.domain);
    const domainMatches = cookieValue.hostOnly
      ? hostname === cookieDomain
      : domainMatch(hostname, cookieDomain);

    if (!domainMatches) {
      return true;
    }

    const cookiePath = cookieValue.path || "/";
    if (!pathMatch(requestPath, cookiePath)) {
      return true;
    }

    return false;
  });

  if (cookies.length !== before) {
    void saveToFile(join(data, "cookies.dat"));
  }
  return cookies.length - before;
}

export function setCookie(setCookieValue: cookie.SetCookie) {
  const now = Date.now();
  const normalizedCookie: StoredCookie = {
    ...(setCookieValue as StoredCookie),
    createdAt: now,
    lastAccessed: now,
  };

  if (normalizedCookie.domain) {
    normalizedCookie.domain = normalizeDomain(normalizedCookie.domain);
  }

  if (!normalizedCookie.path) {
    normalizedCookie.path = "/";
  }

  const expiresAt = getExpiresAt(normalizedCookie);
  if (typeof expiresAt === "number") {
    normalizedCookie.expiresAt = expiresAt;
  }

  cookies = cookies.filter(
    (cookieValue) =>
      !(
        cookieValue.name === normalizedCookie.name &&
        cookieValue.domain === normalizedCookie.domain &&
        cookieValue.path === normalizedCookie.path
      )
  );

  if (isExpired(normalizedCookie)) {
    return false;
  }

  cookies.push(normalizedCookie);
  return true;
}

export function processSetCookie(firstArg: string | string[], secondArg?: string[]) {
    const { requestUrl, setCookieHeaders } = parseProcessSetCookieArgs(
      firstArg,
      secondArg
    );

    let parsedUrl: URL | undefined;
    if (requestUrl) {
      try {
        parsedUrl = new URL(requestUrl);
      } catch {
        parsedUrl = undefined;
      }
    }

    for (const header of setCookieHeaders) {
      const parsedSetCookie = cookie.parseSetCookie(header) as StoredCookie;
      if (!parsedSetCookie.domain && parsedUrl) {
        parsedSetCookie.domain = parsedUrl.hostname.toLowerCase();
        parsedSetCookie.hostOnly = true;
      }
      setCookie(parsedSetCookie);
    }

    void saveToFile(join(data, "cookies.dat"));
  }

ipcMain.handle("cookie.getCookieHeader", (_, url: string) => {
  return cookie.stringifyCookie(getCookies(url));
});

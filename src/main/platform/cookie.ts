import { session } from "electron";
import type { CookiesSetDetails } from "electron";
import * as cookie from "cookie";

import { getADDeviceId, getDeviceId } from "./device";
import { CORE_VERSION, OSVER } from "@shared/constants";

const cookies = session.defaultSession.cookies;

export async function getFullCookies(url: string) {
  return await cookies.get({ url });
}

export async function getCookies(url: string) {
  const fullCookies = await getFullCookies(url);
  return Object.fromEntries(
    fullCookies
      .filter((cookieValue) => cookieValue.value !== undefined)
      .map((cookieValue) => [cookieValue.name, cookieValue.value])
  );
}

export async function removeCookie(url: string, name: string) {
  await cookies.remove(url, name);
}

/** `cookie.SetCookie`, but every field may also be explicitly `undefined`. */
export type SetCookieInput = {
  [K in keyof cookie.SetCookie]?: cookie.SetCookie[K] | undefined;
};

export async function setCookie(url: string, setCookieValue: SetCookieInput) {
  const expirationDate = setCookieValue.expires
    ? Math.floor(new Date(setCookieValue.expires).getTime() / 1000)
    : setCookieValue.maxAge
      ? Math.floor(Date.now() / 1000) + setCookieValue.maxAge
      : undefined;
  const sameSite =
    setCookieValue.sameSite === true
      ? "strict"
      : setCookieValue.sameSite === false
        ? "unspecified"
        : setCookieValue.sameSite === "none"
          ? "no_restriction"
          : setCookieValue.sameSite;

  // Only the attributes Chromium understands are forwarded. The remainder of
  // `cookie.SetCookie` (`expires`, `maxAge`, `partitioned`, `priority`,
  // `sameParty`, `extensions`) is either translated above or meaningless to
  // Electron, so it is deliberately left out rather than spread wholesale.
  const details: CookiesSetDetails = { url };

  if (setCookieValue.name !== undefined) details.name = setCookieValue.name;
  if (setCookieValue.value !== undefined) details.value = setCookieValue.value;
  if (setCookieValue.domain !== undefined)
    details.domain = setCookieValue.domain;
  if (setCookieValue.path !== undefined) details.path = setCookieValue.path;
  if (setCookieValue.secure !== undefined)
    details.secure = setCookieValue.secure;
  if (setCookieValue.httpOnly !== undefined) {
    details.httpOnly = setCookieValue.httpOnly;
  }
  if (expirationDate !== undefined) details.expirationDate = expirationDate;
  if (sameSite !== undefined) details.sameSite = sameSite;

  await cookies.set(details);
}

/**
 * Initializes the cookies.
 *
 * Some cookies are required to be inserted ahead of time, this function will do the job.
 */
export default async function initializeCookies() {
  const initialCookies: Record<string, string> = {
    os: "pc",
    deviceId: getDeviceId(),
    osver: OSVER,
    appver: CORE_VERSION,
    clientSign: getADDeviceId(),
  };

  await Promise.all(
    Object.entries(initialCookies).map(async ([cookie, value]) => {
      await cookies.set({
        name: cookie,
        value,
        url: "https://music.163.com",
        domain: ".music.163.com",
        path: "/",
      });
    })
  );
}

import { beforeEach, describe, expect, it, vi } from "vitest";

// The cookie jar lives in the Electron session, so it is faked here.
const hoisted = vi.hoisted(() => ({
  getCookies: vi.fn(),
  getFullCookies: vi.fn(),
  removeCookie: vi.fn(),
  setCookie: vi.fn(),
}));

vi.mock("@main/cookie", () => hoisted);

import { dispatcher } from "@main/calls";
import { installLoggerStub } from "../../helpers/globals";

installLoggerStub();
const { register: registerBrowser } = await import("@main/calls/browser");
registerBrowser();

/** Dispatch a command and return the tuple spread onto the callback. */
async function call(command: string, ...args: unknown[]) {
  const callback = vi.fn();
  // Handlers take the ipc event as their first argument.
  await dispatcher.dispatch(command, callback, { sender: "test" }, ...args);
  return callback.mock.calls[0] as unknown[];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("browser.getFullCookies", () => {
  it("maps electron cookies to the fields the renderer expects", async () => {
    hoisted.getFullCookies.mockResolvedValue([
      {
        name: "MUSIC_U",
        value: "token",
        domain: ".music.163.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: 2_000_000_000,
      },
    ]);

    const [cookies] = (await call(
      "browser.getFullCookies",
      "https://music.163.com"
    )) as [Record<string, unknown>[]];

    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      Name: "MUSIC_U",
      Value: "token",
      Domain: ".music.163.com",
      Path: "/",
      Secure: 1,
      Httponly: 1,
      HasExpires: 1,
      Expires: 2_000_000_000,
      Url: "https://.music.163.com/",
    });
    expect(cookies[0].Creation).toBeCloseTo(Date.now() / 1000, -2);
  });

  it("falls back to defaults for a session cookie", async () => {
    hoisted.getFullCookies.mockResolvedValue([
      { name: "a", value: "b", secure: false, httpOnly: false },
    ]);

    const [cookies] = (await call("browser.getFullCookies", "https://x")) as [
      Record<string, unknown>[],
    ];

    expect(cookies[0]).toMatchObject({
      Domain: "",
      Path: "/",
      Secure: 0,
      Httponly: 0,
      HasExpires: 0,
      // Built from the raw (missing) fields, as upstream does.
      Url: "http://undefinedundefined",
    });
    expect(cookies[0].Expires as number).toBeGreaterThan(Date.now() / 1000 - 5);
  });
});

describe("browser.getCookies", () => {
  it("returns the plain cookie map", async () => {
    hoisted.getCookies.mockResolvedValue({ MUSIC_U: "token" });

    await expect(call("browser.getCookies", "https://x")).resolves.toEqual([
      { MUSIC_U: "token" },
    ]);
  });
});

describe("browser.setCookie", () => {
  const cookie = {
    Domain: ".music.163.com",
    Name: "MUSIC_U",
    Value: "token",
    Url: "https://music.163.com",
    Path: "/",
    Secure: 1,
    Httponly: 1,
    Expires: 1_900_000_000,
    HasExpires: 1,
  };

  it("rewrites the url hostname to the cookie domain", async () => {
    await expect(call("browser.setCookie", cookie)).resolves.toEqual([true]);

    expect(hoisted.setCookie).toHaveBeenCalledWith("https://music.163.com/", {
      name: "MUSIC_U",
      value: "token",
      domain: ".music.163.com",
      path: "/",
      httpOnly: true,
      secure: true,
      expires: new Date(1_900_000_000 * 1000),
      maxAge: undefined,
      sameSite: undefined,
    });
  });

  it("leaves an already matching hostname alone", async () => {
    await call("browser.setCookie", { ...cookie, Domain: "music.163.com" });

    expect(hoisted.setCookie).toHaveBeenCalledWith(
      "https://music.163.com/",
      expect.objectContaining({ name: "MUSIC_U" })
    );
  });

  it("omits optional fields that were not provided", async () => {
    await call("browser.setCookie", {
      Domain: "music.163.com",
      Name: "n",
      Value: "v",
      Url: "https://music.163.com",
    });

    expect(hoisted.setCookie).toHaveBeenCalledWith(
      "https://music.163.com/",
      expect.objectContaining({
        httpOnly: undefined,
        secure: undefined,
        expires: undefined,
        path: undefined,
      })
    );
  });

  it("reports failure when the cookie cannot be set", async () => {
    hoisted.setCookie.mockRejectedValue(new Error("session gone"));

    await expect(call("browser.setCookie", cookie)).resolves.toEqual([false]);
  });

  it("reports failure for an unparsable url", async () => {
    await expect(
      call("browser.setCookie", { ...cookie, Url: "not a url" })
    ).resolves.toEqual([false]);
    expect(hoisted.setCookie).not.toHaveBeenCalled();
  });
});

describe("browser.removeCookie", () => {
  it("removes an existing cookie", async () => {
    hoisted.getCookies.mockResolvedValue({ MUSIC_U: "token" });

    await expect(
      call("browser.removeCookie", "https://x", "MUSIC_U")
    ).resolves.toEqual([1]);
    expect(hoisted.removeCookie).toHaveBeenCalledWith("https://x", "MUSIC_U");
  });

  it("does nothing for a cookie that is not there", async () => {
    hoisted.getCookies.mockResolvedValue({});

    await expect(
      call("browser.removeCookie", "https://x", "MUSIC_U")
    ).resolves.toEqual([0]);
    expect(hoisted.removeCookie).not.toHaveBeenCalled();
  });
});

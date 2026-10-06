import { describe, expect, it } from "vitest";

import { isAppUrl } from "@main/platform/utils/url";

describe("isAppUrl", () => {
  it("accepts the application's own content", () => {
    expect(isAppUrl("orpheus://orpheus/")).toBe(true);
    expect(isAppUrl("orpheus://orpheus/index.html?v=2")).toBe(true);
  });

  it("refuses the cached remote content the same scheme also serves", () => {
    // `orpheus://cache?<url>` fetches and returns remote bodies, so a page
    // loaded that way would run with the application preload.
    expect(isAppUrl("orpheus://cache?https://evil.example/x.html")).toBe(false);
  });

  it("refuses anything that is not the application's own content", () => {
    expect(isAppUrl("https://evil.example/x.html")).toBe(false);
    expect(isAppUrl("file:///etc/passwd")).toBe(false);
    expect(isAppUrl("orpheus://orpheus.evil.example/")).toBe(false);
    expect(isAppUrl("not a url")).toBe(false);
  });
});

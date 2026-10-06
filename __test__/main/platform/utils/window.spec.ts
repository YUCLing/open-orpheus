import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  screen: { getDisplayMatching: vi.fn(() => ({ scaleFactor: 2 })) },
}));

import { getWindowScaleFactor } from "@main/platform/utils/window";

describe("getWindowScaleFactor", () => {
  it("reports the scale factor of the matching display", () => {
    const wnd = { getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) };
    expect(getWindowScaleFactor(wnd as never)).toBe(2);
  });
});

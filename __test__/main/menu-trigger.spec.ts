import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

import {
  clearMenuTrigger,
  rememberMenuTrigger,
  takeMenuTrigger,
} from "../../src/main/menu/trigger";

function fakeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => true),
  };
}
function windowHandle(window: ReturnType<typeof fakeWindow>) {
  return window as unknown as BrowserWindow;
}

describe("forwarded menu trigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses the lyrics window once without changing the requester's identity", () => {
    const main = windowHandle(fakeWindow());
    const lyrics = windowHandle(fakeWindow());
    rememberMenuTrigger(main, lyrics);
    expect(takeMenuTrigger(main)).toBe(lyrics);
    expect(takeMenuTrigger(main)).toBeNull();
  });

  it("does not route another window's request to lyrics", () => {
    const main = windowHandle(fakeWindow());
    const other = windowHandle(fakeWindow());
    const lyrics = windowHandle(fakeWindow());
    rememberMenuTrigger(main, lyrics);
    expect(takeMenuTrigger(other)).toBeNull();
    expect(takeMenuTrigger(main)).toBe(lyrics);
  });

  it("discards a trigger after focus moves away from lyrics", () => {
    const main = windowHandle(fakeWindow());
    const lyrics = fakeWindow();
    rememberMenuTrigger(main, windowHandle(lyrics));
    lyrics.isFocused.mockReturnValue(false);
    expect(takeMenuTrigger(main)).toBeNull();
    lyrics.isFocused.mockReturnValue(true);
    expect(takeMenuTrigger(main)).toBeNull();
  });

  it("does not touch a closed source window's native methods", () => {
    const main = windowHandle(fakeWindow());
    const lyrics = fakeWindow();
    rememberMenuTrigger(main, windowHandle(lyrics));
    lyrics.isDestroyed.mockReturnValue(true);
    expect(takeMenuTrigger(main)).toBeNull();
    expect(lyrics.isFocused).not.toHaveBeenCalled();
  });

  it("discards a trigger when the requester has closed", () => {
    const main = fakeWindow();
    rememberMenuTrigger(windowHandle(main), windowHandle(fakeWindow()));
    main.isDestroyed.mockReturnValue(true);
    expect(takeMenuTrigger(windowHandle(main))).toBeNull();
  });

  it("expires an unconsumed action", () => {
    const main = windowHandle(fakeWindow());
    rememberMenuTrigger(main, windowHandle(fakeWindow()));
    vi.advanceTimersByTime(1_000);
    expect(takeMenuTrigger(main)).toBeNull();
  });

  it("clears a pending menu when another lyrics action is forwarded", () => {
    const main = windowHandle(fakeWindow());
    rememberMenuTrigger(main, windowHandle(fakeWindow()));
    clearMenuTrigger(main);
    expect(takeMenuTrigger(main)).toBeNull();
  });

  it("replaces a previous action with the latest source", () => {
    const main = windowHandle(fakeWindow());
    const newer = windowHandle(fakeWindow());
    rememberMenuTrigger(main, windowHandle(fakeWindow()));
    rememberMenuTrigger(main, newer);
    expect(takeMenuTrigger(main)).toBe(newer);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  isLiveFocusedWindow,
  runMenuCallbacks,
  scheduleMenuTask,
} from "../../src/main/menu/lifecycle";

describe("menu lifecycle", () => {
  it("cancels old blur tasks when disposing or falling back", () => {
    vi.useFakeTimers();
    try {
      const dismiss = vi.fn();
      const cleanups: Array<() => void> = [];
      scheduleMenuTask(dismiss, 50, cleanups);
      scheduleMenuTask(dismiss, 100, cleanups);
      runMenuCallbacks(cleanups.splice(0), vi.fn());
      vi.advanceTimersByTime(200);
      expect(dismiss).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes finished and cancelled timers without removing other resources", () => {
    vi.useFakeTimers();
    try {
      const other = vi.fn();
      const cleanups = [other];
      const first = vi.fn();
      const second = vi.fn();
      const cancelFirst = scheduleMenuTask(first, 50, cleanups);
      const cancelSecond = scheduleMenuTask(second, 100, cleanups);
      expect(cleanups).toHaveLength(3);
      vi.advanceTimersByTime(50);
      expect(first).toHaveBeenCalledOnce();
      expect(cleanups).toEqual([other, cancelSecond]);
      cancelFirst();
      cancelSecond();
      cancelSecond();
      expect(cleanups).toEqual([other]);
      vi.advanceTimersByTime(100);
      expect(second).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches before executing a callback that throws or disposes other timers", () => {
    vi.useFakeTimers();
    try {
      const cleanups: Array<() => void> = [];
      const later = vi.fn();
      scheduleMenuTask(
        () => {
          expect(cleanups).toHaveLength(1);
          runMenuCallbacks(cleanups.splice(0), vi.fn());
          throw new Error("timer failure");
        },
        50,
        cleanups
      );
      scheduleMenuTask(later, 100, cleanups);
      expect(() => vi.advanceTimersByTime(50)).toThrow("timer failure");
      expect(cleanups).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(later).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues disposal even when error reporting throws", () => {
    const last = vi.fn();
    expect(() =>
      runMenuCallbacks(
        [
          () => {
            throw new Error("cleanup");
          },
          last,
        ],
        () => {
          throw new Error("logger");
        }
      )
    ).not.toThrow();
    expect(last).toHaveBeenCalledOnce();
  });
  it("continues cleanup after a callback throws", () => {
    const failure = new Error("destroyed window");
    const first = vi.fn(() => {
      throw failure;
    });
    const last = vi.fn();
    const report = vi.fn();
    expect(() => runMenuCallbacks([first, last], report)).not.toThrow();
    expect(report).toHaveBeenCalledWith(failure);
    expect(last).toHaveBeenCalledOnce();
  });

  it("does not query focus on a destroyed window", () => {
    const isFocused = vi.fn(() => {
      throw new Error("Object has been destroyed");
    });
    expect(isLiveFocusedWindow({ isDestroyed: () => true, isFocused })).toBe(false);
    expect(isFocused).not.toHaveBeenCalled();
    expect(isLiveFocusedWindow(null)).toBe(false);
    expect(isLiveFocusedWindow({ isDestroyed: () => false, isFocused: () => true })).toBe(true);
  });
});

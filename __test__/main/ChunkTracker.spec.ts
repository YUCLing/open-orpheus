import { describe, expect, it } from "vitest";

import ChunkTracker from "@main/audio/ChunkTracker";

function trackerWith(...ranges: [number, number][]) {
  const tracker = new ChunkTracker();
  for (const [start, end] of ranges) tracker.addInterval(start, end);
  return tracker;
}

describe("ChunkTracker.addInterval", () => {
  it("starts empty", () => {
    const tracker = new ChunkTracker();
    expect(tracker.loadedBytes).toBe(0);
    expect(tracker.getIntervals()).toEqual([]);
  });

  it("returns the number of newly covered bytes", () => {
    const tracker = new ChunkTracker();
    expect(tracker.addInterval(0, 100)).toBe(100);
    expect(tracker.addInterval(100, 200)).toBe(100);
    expect(tracker.loadedBytes).toBe(200);
  });

  it("counts only the uncovered part of an overlapping interval", () => {
    const tracker = trackerWith([0, 100]);
    expect(tracker.addInterval(50, 150)).toBe(50);
    expect(tracker.loadedBytes).toBe(150);
  });

  it("returns 0 for an interval that is already covered", () => {
    const tracker = trackerWith([0, 100]);
    expect(tracker.addInterval(10, 90)).toBe(0);
    expect(tracker.getIntervals()).toEqual([{ start: 0, end: 100 }]);
  });

  it("merges intervals that touch", () => {
    const tracker = trackerWith([0, 100], [100, 200]);
    expect(tracker.getIntervals()).toEqual([{ start: 0, end: 200 }]);
  });

  it("merges intervals separated by a small gap", () => {
    const tracker = trackerWith([0, 100], [300, 400]);
    // 300 bytes requested, 100 of them already covered.
    expect(tracker.addInterval(50, 350)).toBe(200);
    expect(tracker.getIntervals()).toEqual([{ start: 0, end: 400 }]);
  });

  it("inserts an earlier interval in sorted order", () => {
    const tracker = trackerWith([300, 400], [500, 600]);
    expect(tracker.addInterval(0, 100)).toBe(100);
    expect(tracker.getIntervals()).toEqual([
      { start: 0, end: 100 },
      { start: 300, end: 400 },
      { start: 500, end: 600 },
    ]);
  });

  it("bridges several intervals at once", () => {
    const tracker = trackerWith([0, 100], [200, 300], [400, 500]);
    // 400 bytes requested, 200 of them already covered by the three intervals.
    expect(tracker.addInterval(50, 450)).toBe(200);
    expect(tracker.getIntervals()).toEqual([{ start: 0, end: 500 }]);
  });

  it("clamps negative offsets to zero", () => {
    const tracker = new ChunkTracker();
    expect(tracker.addInterval(-50, 10)).toBe(10);
    expect(tracker.getIntervals()).toEqual([{ start: 0, end: 10 }]);
  });

  it("truncates fractional offsets", () => {
    const tracker = new ChunkTracker();
    expect(tracker.addInterval(1.9, 5.9)).toBe(4);
    expect(tracker.getIntervals()).toEqual([{ start: 1, end: 5 }]);
  });

  it("ignores degenerate and non-finite intervals", () => {
    const tracker = new ChunkTracker();

    expect(tracker.addInterval(10, 10)).toBe(0);
    expect(tracker.addInterval(100, 50)).toBe(0);
    expect(tracker.addInterval(NaN, 10)).toBe(0);
    expect(tracker.addInterval(0, Infinity)).toBe(0);
    expect(tracker.loadedBytes).toBe(0);
    expect(tracker.getIntervals()).toEqual([]);
  });

  it("returns defensive copies of the intervals", () => {
    const tracker = trackerWith([0, 100]);
    const intervals = tracker.getIntervals();

    intervals[0].start = 999;

    expect(tracker.getIntervals()).toEqual([{ start: 0, end: 100 }]);
  });
});

describe("ChunkTracker queries", () => {
  const tracker = () => trackerWith([100, 200], [300, 400]);

  it("finds the contiguous downloaded end", () => {
    const t = tracker();
    expect(t.getDownloadedEnd(100, 1000)).toBe(200);
    expect(t.getDownloadedEnd(150, 1000)).toBe(200);
    expect(t.getDownloadedEnd(250, 1000)).toBe(250);
    expect(t.getDownloadedEnd(100, 150)).toBe(150);
    expect(t.getDownloadedEnd(0, 1000)).toBe(0);
    expect(new ChunkTracker().getDownloadedEnd(42, 1000)).toBe(42);
  });

  it("reports the downloadable span from an offset", () => {
    const t = tracker();
    expect(t.getDownloadedSpanFrom(150, 1000)).toBe(50);
    expect(t.getDownloadedSpanFrom(250, 1000)).toBe(0);
    expect(t.getDownloadedSpanFrom(0, 1000)).toBe(0);
  });

  it("finds the end of the gap after an offset", () => {
    const t = tracker();
    expect(t.getGapEnd(200, 1000)).toBe(300);
    expect(t.getGapEnd(0, 1000)).toBe(100);
    expect(t.getGapEnd(500, 1000)).toBe(1000);
    // A limited request clamps the gap to the requested end.
    expect(t.getGapEnd(250, 260)).toBe(260);
    // Starting inside a downloaded interval means there is no gap at all.
    expect(t.getGapEnd(150, 1000)).toBe(150);
    expect(t.getGapEnd(350, 1000)).toBe(350);
  });

  it("checks whether a range is downloaded", () => {
    const t = tracker();
    expect(t.isRangeDownloaded(100, 200)).toBe(true);
    expect(t.isRangeDownloaded(100, 201)).toBe(false);
    expect(t.isRangeDownloaded(150, 250)).toBe(false);
  });

  it("lists the missing sub-ranges", () => {
    expect(tracker().getMissingIntervals(0, 500)).toEqual([
      { start: 0, end: 100 },
      { start: 200, end: 300 },
      { start: 400, end: 500 },
    ]);
    expect(tracker().getMissingIntervals(120, 180)).toEqual([]);
    expect(tracker().getMissingIntervals(200, 300)).toEqual([
      { start: 200, end: 300 },
    ]);
    expect(new ChunkTracker().getMissingIntervals(5, 10)).toEqual([
      { start: 5, end: 10 },
    ]);
  });

  it("alternates hit and miss instructions", () => {
    expect(tracker().getInstructions(0, 500)).toEqual([
      { type: "miss", start: 0, end: 100 },
      { type: "hit", start: 100, end: 200 },
      { type: "miss", start: 200, end: 300 },
      { type: "hit", start: 300, end: 400 },
      { type: "miss", start: 400, end: 500 },
    ]);
  });

  it("emits a single instruction for a fully missing or fully hit range", () => {
    expect(new ChunkTracker().getInstructions(0, 100)).toEqual([
      { type: "miss", start: 0, end: 100 },
    ]);
    expect(trackerWith([0, 100]).getInstructions(0, 100)).toEqual([
      { type: "hit", start: 0, end: 100 },
    ]);
  });
});

describe("ChunkTracker.isComplete", () => {
  it("is false for a zero length stream", () => {
    expect(new ChunkTracker().isComplete(0)).toBe(false);
    expect(trackerWith([0, 100]).isComplete(0)).toBe(false);
  });

  it("is false while a prefix is missing", () => {
    expect(trackerWith([100, 200]).isComplete(200)).toBe(false);
    expect(trackerWith([0, 100]).isComplete(200)).toBe(false);
  });

  it("is true once the whole file is covered", () => {
    expect(trackerWith([0, 100], [100, 200]).isComplete(200)).toBe(true);
    expect(trackerWith([0, 200]).isComplete(200)).toBe(true);
  });
});

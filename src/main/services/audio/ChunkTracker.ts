export type ChunkInterval = {
  start: number;
  end: number;
};

export type ChunkInstruction = ChunkInterval & {
  type: "hit" | "miss";
};

export default class ChunkTracker {
  private intervals: ChunkInterval[] = [];

  get loadedBytes() {
    return this.intervals.reduce(
      (total, interval) => total + interval.end - interval.start,
      0
    );
  }

  addInterval(start: number, end: number) {
    const normalized = normalizeInterval(start, end);
    if (!normalized) return 0;

    const before = this.loadedBytes;
    let nextStart = normalized.start;
    let nextEnd = normalized.end;
    let inserted = false;
    const nextIntervals: ChunkInterval[] = [];

    for (const interval of this.intervals) {
      if (interval.end < nextStart) {
        nextIntervals.push(interval);
        continue;
      }

      if (nextEnd < interval.start) {
        if (!inserted) {
          nextIntervals.push({ start: nextStart, end: nextEnd });
          inserted = true;
        }
        nextIntervals.push(interval);
        continue;
      }

      nextStart = Math.min(nextStart, interval.start);
      nextEnd = Math.max(nextEnd, interval.end);
    }

    if (!inserted) {
      nextIntervals.push({ start: nextStart, end: nextEnd });
    }

    this.intervals = nextIntervals;
    return this.loadedBytes - before;
  }

  getIntervals() {
    return this.intervals.map((interval) => ({ ...interval }));
  }

  getDownloadedEnd(start: number, limit: number) {
    for (const interval of this.intervals) {
      if (interval.end <= start) continue;
      if (interval.start > start) return start;
      return Math.min(interval.end, limit);
    }
    return start;
  }

  getDownloadedSpanFrom(start: number, limit: number) {
    return this.getDownloadedEnd(start, limit) - start;
  }

  getGapEnd(start: number, limit: number) {
    for (const interval of this.intervals) {
      if (interval.end <= start) continue;
      if (interval.start > start) return Math.min(interval.start, limit);
      return start;
    }
    return limit;
  }

  isRangeDownloaded(start: number, end: number) {
    return this.getDownloadedEnd(start, end) >= end;
  }

  getMissingIntervals(start: number, end: number) {
    const missing: ChunkInterval[] = [];
    let cursor = start;

    for (const interval of this.intervals) {
      if (interval.end <= cursor) continue;
      if (interval.start >= end) break;

      if (interval.start > cursor) {
        missing.push({ start: cursor, end: Math.min(interval.start, end) });
      }
      cursor = Math.max(cursor, interval.end);
      if (cursor >= end) break;
    }

    if (cursor < end) {
      missing.push({ start: cursor, end });
    }

    return missing;
  }

  getInstructions(start: number, end: number) {
    const instructions: ChunkInstruction[] = [];
    let cursor = start;

    while (cursor < end) {
      const hitEnd = this.getDownloadedEnd(cursor, end);
      if (hitEnd > cursor) {
        instructions.push({ type: "hit", start: cursor, end: hitEnd });
        cursor = hitEnd;
        continue;
      }

      const missEnd = this.getGapEnd(cursor, end);
      instructions.push({ type: "miss", start: cursor, end: missEnd });
      cursor = missEnd;
    }

    return instructions;
  }

  isComplete(totalLength: number) {
    return totalLength > 0 && this.isRangeDownloaded(0, totalLength);
  }
}

function normalizeInterval(start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const normalizedStart = Math.max(0, Math.trunc(start));
  const normalizedEnd = Math.max(0, Math.trunc(end));
  if (normalizedEnd <= normalizedStart) return null;

  return { start: normalizedStart, end: normalizedEnd };
}

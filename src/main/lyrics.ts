export interface LyricWord {
  text: string;
  start_time: number;
  duration: number;
}

export interface LyricLine {
  start_time: number;
  end_time: number;
  words: LyricWord[];
}

export interface LyricsData {
  lines: LyricLine[];
  secondary_lines?: LyricLine[];
}

/**
 * Parse a timestamp tag like `[mm:ss.xx]` or `[mm:ss:xx]` into milliseconds.
 * Returns `null` if the tag is not a valid timestamp.
 */
function parseTimestamp(tag: string): number | null {
  const match = tag.match(/^\[(\d+)[:.'](\d+)(?:[:.'](\d+))?\]$/);
  if (!match) return null;

  const minutes = parseInt(match[1], 10);
  const seconds = parseInt(match[2], 10);
  const frac = match[3];

  if (isNaN(minutes) || isNaN(seconds)) return null;

  let ms = minutes * 60_000 + seconds * 1000;
  if (frac !== undefined) {
    const fracVal = parseInt(frac, 10);
    if (isNaN(fracVal)) return null;
    // If 2 digits, treat as centiseconds (e.g. 03 → 30ms); if 3 digits, milliseconds
    ms += frac.length <= 2 ? fracVal * 10 : fracVal;
  }
  return ms;
}

/**
 * Parse an LRC string into a {@link LyricsData} structure compatible with the
 * native lyrics rendering component.
 *
 * Each `[mm:ss.xx]` line becomes a {@link LyricLine} with a single
 * {@link LyricWord} spanning the entire line (plain LRC has no per-word
 * timing). `end_time` is inferred from the next line's `start_time`.
 */
export function parseLrc(lrc: string, secondaryLrc?: string): LyricsData {
  return {
    lines: parseLrcLines(lrc),
    secondary_lines: secondaryLrc ? parseLrcLines(secondaryLrc) : undefined,
  };
}

function parseLrcLines(lrc: string): LyricLine[] {
  if (typeof lrc !== "string") return [];

  const entries: { time: number; text: string }[] = [];
  const tagPattern = /\[([^\]]*)\]/g;

  for (const raw of lrc.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    // Collect all tags at the start of the line
    const times: number[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    tagPattern.lastIndex = 0;

    while ((m = tagPattern.exec(line)) !== null && m.index === lastIndex) {
      const ts = parseTimestamp(m[0]);
      if (ts !== null) times.push(ts);
      lastIndex = tagPattern.lastIndex;
    }

    if (times.length === 0) continue;
    const text = line.slice(lastIndex).trimEnd();

    // A single line can have multiple timestamps (e.g. `[00:01.00][00:30.00]text`)
    for (const time of times) {
      entries.push({ time, text });
    }
  }

  // Sort by timestamp
  entries.sort((a, b) => a.time - b.time);

  // Convert to LyricLine[], inferring end_time from the next line
  return entries.map((entry, i) => {
    const nextTime =
      i + 1 < entries.length ? entries[i + 1].time : entry.time + 5000;
    return {
      start_time: entry.time,
      end_time: nextTime,
      words: [
        { text: entry.text, start_time: 0, duration: nextTime - entry.time },
      ],
    };
  });
}

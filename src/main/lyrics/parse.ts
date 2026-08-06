import type { LyricLine, LyricWord, Lyrics } from "$sharedTypes/lyrics";

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
 * Parse a NetEase extended LRC line such as
 * `{"t":0,"c":[{"tx":"作曲："},{"tx":"玉屋2060%"}]}`.
 *
 * `t` is the timestamp in milliseconds and `c` is a rich-text array whose
 * actual text is the concatenation of each `tx` field. Returns `null` when
 * the line is not a recognized NetEase JSON lyric entry.
 */
export function parseNeteaseJsonLyricLine(
  line: string
): { time: number; text: string } | null {
  if (!line.startsWith("{")) return null;

  let parsed: { t?: unknown; c?: unknown };
  try {
    parsed = JSON.parse(line) as { t?: unknown; c?: unknown };
  } catch {
    return null;
  }

  if (typeof parsed.t !== "number" || !Array.isArray(parsed.c)) return null;

  const text = parsed.c
    .map((segment) => {
      if (typeof segment !== "object" || segment === null) return "";
      const tx = (segment as { tx?: unknown }).tx;
      return typeof tx === "string" ? tx : "";
    })
    .join("");

  return { time: parsed.t, text };
}

/**
 * Parse an LRC string into {@link Lyrics}.
 *
 * Each `[mm:ss.xx]` line becomes a {@link LyricsLine} with a single
 * {@link LyricWord} spanning the entire line (plain LRC has no per-word
 * timing). `end_time` is inferred from the next line's `start_time`.
 */
export function parseLrc(lrc: string): Lyrics {
  if (typeof lrc !== "string") return [];

  const entries: { time: number; text: string }[] = [];
  const tagPattern = /\[([^\]]*)\]/g;

  for (const raw of lrc.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const jsonEntry = parseNeteaseJsonLyricLine(line);
    if (jsonEntry) {
      entries.push(jsonEntry);
      continue;
    }

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

/**
 * Parse a YRC (per-character lyrics) string into {@link Lyrics}.
 *
 * Format:
 *   `[line_start_ms, line_duration_ms](char_start_ms, char_duration_ms, flag)字...`
 *
 * Each line opens with a `[start, duration]` header (both in milliseconds)
 * followed by zero or more per-character `(start, duration, flag)` tuples.
 * The character itself immediately follows the closing parenthesis.
 * `start_time` on each {@link LyricWord} is stored relative to its line.
 */
export function parseYrc(yrc: string): Lyrics {
  if (typeof yrc !== "string") return [];

  const lines: LyricLine[] = [];
  const tupleRe = /\((\d+),\s*(\d+),\s*(\d+)\)/g;

  for (const raw of yrc.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    // ── line header: [start_ms, duration_ms] ──
    const hdr = line.match(/^\[(\d+),\s*(\d+)\]/);
    if (!hdr) continue;

    const lineStart = parseInt(hdr[1], 10);
    const lineDuration = parseInt(hdr[2], 10);
    if (isNaN(lineStart) || isNaN(lineDuration)) continue;

    // ── per-character tuples ──
    const words: LyricWord[] = [];
    tupleRe.lastIndex = hdr[0].length;

    let m: RegExpExecArray | null;
    while ((m = tupleRe.exec(line)) !== null) {
      const textStart = m.index + m[0].length;
      if (textStart >= line.length) break;

      // Collect everything until the next '(' (or end of line) as one word
      const nextTuple = line.indexOf("(", textStart);
      const textEnd = nextTuple === -1 ? line.length : nextTuple;
      const text = line.slice(textStart, textEnd);

      const absStart = parseInt(m[1], 10);
      const duration = parseInt(m[2], 10);

      words.push({
        text,
        start_time: absStart - lineStart,
        duration,
      });

      // Advance regex lastIndex past the text we consumed so the next
      // exec() picks up the following tuple naturally
      tupleRe.lastIndex = textEnd;
    }

    if (words.length > 0) {
      lines.push({
        start_time: lineStart,
        end_time: lineStart + lineDuration,
        words,
      });
    }
  }

  return lines;
}

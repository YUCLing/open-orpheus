import { ipcRenderer } from "electron";

import { player } from "./audioplayer";
import type { LyricContent } from "./Player";
import { parseLrc, type LyricLine, type LyricsData } from "../main/lyrics";

let lyrics: LyricsData | null = null;
let lastText: string | null = null;
let rafId: number | null = null;
let activePlayId = "";
let lyricRevision = 0;
let lyricRevisionAtLastPlayInfo = 0;
let lastLyricContent: LyricContent | null | undefined;

function sendText(text: string | null): void {
  if (text === lastText) return;
  lastText = text;
  ipcRenderer.send("trayLyrics.updateText", text);
}

function updateLyrics(
  content: LyricContent | null = player.lyricContent
): void {
  if (content !== lastLyricContent) {
    lyricRevision += 1;
    lastLyricContent = content;
  }
  lyrics = parsePrimaryLyrics(content);
  lastText = null;
  updateTextFromAudioClock();
}

function updateTextFromAudioClock(): void {
  if (!lyrics?.lines.length) {
    sendText(null);
    return;
  }

  const line = findCurrentLine(lyrics.lines, getAdjustedAudioTime());
  sendText(line ? getLineText(line) : "");
}

function getAdjustedAudioTime(): number {
  return player.audio.currentTime * 1000 + player.lyricStyle.offset;
}

function startRaf(): void {
  if (rafId !== null) return;

  const tick = () => {
    updateTextFromAudioClock();
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
}

function stopRaf(): void {
  if (rafId === null) return;
  cancelAnimationFrame(rafId);
  rafId = null;
}

function syncRafState(): void {
  if (shouldTrackAudioClock(player.audio)) {
    startRaf();
  } else {
    stopRaf();
  }
}

function shouldTrackAudioClock(audio: HTMLAudioElement): boolean {
  return !audio.paused && !audio.ended;
}

player.addEventListener("lyriccontentupdate", (event) => {
  updateLyrics((event as CustomEvent<LyricContent | null>).detail);
});

player.addEventListener("playinfoupdate", () => {
  const playId = player.currentId;
  if (playId === activePlayId) return;

  const lyricsChangedSinceLastPlayInfo =
    lyricRevision > lyricRevisionAtLastPlayInfo;
  activePlayId = playId;
  lastText = null;
  lyricRevisionAtLastPlayInfo = lyricRevision;

  if (lyricsChangedSinceLastPlayInfo) {
    updateTextFromAudioClock();
  } else {
    lyrics = null;
    sendText(null);
  }
});

player.addEventListener("load", () => {
  updateTextFromAudioClock();
  syncRafState();
});

player.audio.addEventListener("play", () => {
  updateTextFromAudioClock();
  startRaf();
});

player.audio.addEventListener("playing", () => {
  updateTextFromAudioClock();
  startRaf();
});

player.audio.addEventListener("pause", () => {
  updateTextFromAudioClock();
  stopRaf();
});

player.audio.addEventListener("ended", () => {
  updateTextFromAudioClock();
  stopRaf();
});

player.audio.addEventListener("error", () => {
  updateTextFromAudioClock();
  stopRaf();
});

player.addEventListener("lyricstyleupdate", (event) => {
  const { key } = (event as CustomEvent<{ key: string; value: unknown }>)
    .detail;
  if (key === "offset") {
    updateTextFromAudioClock();
  }
});

[
  "loadedmetadata",
  "canplay",
  "canplaythrough",
  "durationchange",
  "ratechange",
  "seeked",
  "seeking",
  "stalled",
  "timeupdate",
  "waiting",
].forEach((event) => {
  player.audio.addEventListener(event, () => {
    updateTextFromAudioClock();
    syncRafState();
  });
});

updateLyrics();
syncRafState();

function parsePrimaryLyrics(content: LyricContent | null): LyricsData | null {
  if (!content) return null;

  return (
    parseEnhancedTimedLyrics(content.yrc) ||
    parseEnhancedTimedLyrics(content.krc) ||
    (content.lrc ? keepPrimaryLines(parseLrc(content.lrc)) : null)
  );
}

function parseEnhancedTimedLyrics(raw: string): LyricsData | null {
  if (!raw || typeof raw !== "string") return null;

  const entries: LyricLine[] = [];

  for (const rawLine of raw.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!match) continue;

    const startTime = parseInt(match[1], 10);
    const duration = parseInt(match[2], 10);
    if (!Number.isFinite(startTime) || !Number.isFinite(duration)) continue;

    entries.push({
      start_time: startTime,
      end_time: duration > 0 ? startTime + duration : startTime,
      words: [
        {
          text: filterOriginalLyricText(stripInlineTimingTags(match[3])),
          start_time: 0,
          duration,
        },
      ],
    });
  }

  if (entries.length === 0) return null;

  return keepPrimaryLines({ lines: entries });
}

function stripInlineTimingTags(value: string): string {
  return value
    .replace(/\(\d+,\d+(?:,\d+)?\)/g, "")
    .replace(/<\d+,\d+(?:,\d+)?>/g, "");
}

function keepPrimaryLines(data: LyricsData): LyricsData {
  const linesByStartTime = new Map<number, LyricLine>();

  for (const line of data.lines) {
    if (linesByStartTime.has(line.start_time)) continue;

    const text = filterOriginalLyricText(getLineText(line));
    linesByStartTime.set(line.start_time, {
      ...line,
      words: [
        { text, start_time: 0, duration: line.end_time - line.start_time },
      ],
    });
  }

  const lines = [...linesByStartTime.values()].sort(
    (a, b) => a.start_time - b.start_time
  );

  return {
    lines: lines.map((line, index) => {
      const inferredEndTime =
        lines[index + 1]?.start_time ?? line.start_time + 5000;
      const endTime =
        line.end_time > line.start_time ? line.end_time : inferredEndTime;

      return {
        ...line,
        end_time: endTime,
        words: line.words.map((word) => ({
          ...word,
          duration: endTime - line.start_time,
        })),
      };
    }),
  };
}

function findCurrentLine(lines: LyricLine[], timeMs: number): LyricLine | null {
  let left = 0;
  let right = lines.length - 1;
  let current: LyricLine | null = null;

  while (left <= right) {
    const middle = (left + right) >> 1;
    const line = lines[middle];

    if (line.start_time <= timeMs) {
      current = line;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }

  if (!current || timeMs >= current.end_time) return null;
  return current;
}

function getLineText(line: LyricLine): string {
  return line.words.map((word) => word.text).join("");
}

function filterOriginalLyricText(value: string): string {
  const cleaned = value
    .replace(/\\n/g, "\n")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/<\d+,\d+,\d+>/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .trim();

  if (!cleaned) return "";

  const firstLine = cleaned
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);

  if (!firstLine) return "";

  return firstLine
    .split(/\s+(?:\/{1,2}|[|\uFF5C]|[-\u2013\u2014])\s+/u)[0]
    .trim();
}

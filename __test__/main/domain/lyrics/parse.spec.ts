import { describe, expect, it } from "vitest";

import { parseLrc, parseYrc } from "@main/domain/lyrics/parse";

describe("parseLrc", () => {
  it("parses timestamps, text and inferred end times", () => {
    expect(parseLrc("[00:01.00]Hello\n[00:02.50]World")).toEqual([
      {
        start_time: 1000,
        end_time: 2500,
        words: [{ text: "Hello", start_time: 0, duration: 1500 }],
      },
      {
        start_time: 2500,
        end_time: 7500,
        words: [{ text: "World", start_time: 0, duration: 5000 }],
      },
    ]);
  });

  it("gives the final line a 5 second tail", () => {
    const [line] = parseLrc("[00:10.00]Only");
    expect(line.start_time).toBe(10_000);
    expect(line.end_time).toBe(15_000);
    expect(line.words[0].duration).toBe(5000);
  });

  it("expands multiple timestamps on a single line", () => {
    const lines = parseLrc("[00:01.00][00:30.00]Chorus");

    expect(lines.map((line) => line.start_time)).toEqual([1000, 30_000]);
    expect(lines.map((line) => line.words[0].text)).toEqual([
      "Chorus",
      "Chorus",
    ]);
    expect(lines[0].end_time).toBe(30_000);
  });

  it("sorts lines by timestamp", () => {
    const lines = parseLrc("[00:09.00]b\n[00:03.00]a");
    expect(lines.map((line) => line.words[0].text)).toEqual(["a", "b"]);
  });

  it("accepts `:` and `'` as fraction separators", () => {
    expect(parseLrc("[01:02:03]x")[0].start_time).toBe(62_030);
    expect(parseLrc("[01:02'03]x")[0].start_time).toBe(62_030);
  });

  it("treats 3-digit fractions as milliseconds and 1-2 digit ones as centiseconds", () => {
    expect(parseLrc("[00:00.123]x")[0].start_time).toBe(123);
    expect(parseLrc("[00:00.12]x")[0].start_time).toBe(120);
    expect(parseLrc("[00:00.5]x")[0].start_time).toBe(50);
  });

  it("skips metadata tags and blank lines", () => {
    const lines = parseLrc(
      "[ti:Title]\n\n[ar:Artist]\n[00:01.00]Hello\n[al:Album]"
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].words[0].text).toBe("Hello");
  });

  it("ignores tags that are not at the start of the line", () => {
    expect(parseLrc("prefix [00:01.00] tail")).toEqual([]);
  });

  it("keeps lines with empty text", () => {
    expect(parseLrc("[00:01.00]")).toEqual([
      {
        start_time: 1000,
        end_time: 6000,
        words: [{ text: "", start_time: 0, duration: 5000 }],
      },
    ]);
  });

  it("trims trailing whitespace and handles CRLF input", () => {
    const lines = parseLrc("[00:01.00]Hello   \r\n[00:02.00]World\r\n");
    expect(lines[0].words[0].text).toBe("Hello");
    expect(lines[1].words[0].text).toBe("World");
  });

  it("returns an empty array for non-string input", () => {
    expect(parseLrc(undefined as unknown as string)).toEqual([]);
    expect(parseLrc(null as unknown as string)).toEqual([]);
  });

  it("returns an empty array when nothing parses", () => {
    expect(parseLrc("just some plain text")).toEqual([]);
    expect(parseLrc("")).toEqual([]);
  });
});

describe("parseYrc", () => {
  it("parses line headers and per-character tuples", () => {
    expect(
      parseYrc("[1000,4000](1000,1000,0)He(2000,1000,0)llo(3000,2000,0)!!")
    ).toEqual([
      {
        start_time: 1000,
        end_time: 5000,
        words: [
          { text: "He", start_time: 0, duration: 1000 },
          { text: "llo", start_time: 1000, duration: 1000 },
          { text: "!!", start_time: 2000, duration: 2000 },
        ],
      },
    ]);
  });

  it("stores word start times relative to the line", () => {
    const [line] = parseYrc("[5000,1000](5000,400,0)A(5400,600,0)B");
    expect(line.start_time).toBe(5000);
    expect(line.words.map((word) => word.start_time)).toEqual([0, 400]);
    expect(line.words.map((word) => word.duration)).toEqual([400, 600]);
  });

  it("parses several lines", () => {
    const lines = parseYrc("[0,1000](0,500,0)A\n[1000,1000](1000,500,0)B");
    expect(lines.map((line) => line.start_time)).toEqual([0, 1000]);
    expect(lines.map((line) => line.words[0].text)).toEqual(["A", "B"]);
  });

  it("allows whitespace inside the line header", () => {
    expect(parseYrc("[1000, 2000](1000, 500, 0)Hi")).toHaveLength(1);
  });

  it("drops the trailing tuple when no text follows it", () => {
    const [line] = parseYrc("[0,2000](0,500,0)A(500,500,0)");
    expect(line.words).toEqual([{ text: "A", start_time: 0, duration: 500 }]);
  });

  it("skips lines without a YRC header", () => {
    expect(parseYrc("[00:01.00]plain lrc")).toEqual([]);
    expect(parseYrc("garbage")).toEqual([]);
    expect(parseYrc("")).toEqual([]);
  });

  it("skips header-only lines with no words", () => {
    expect(parseYrc("[1000,2000]")).toEqual([]);
  });

  it("skips blank lines between entries", () => {
    expect(parseYrc("\n[0,1000](0,500,0)A\n\n")).toHaveLength(1);
  });

  it("returns an empty array for non-string input", () => {
    expect(parseYrc(null as unknown as string)).toEqual([]);
  });
});

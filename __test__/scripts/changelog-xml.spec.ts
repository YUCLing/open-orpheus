import { describe, expect, it } from "vitest";

import {
  extractBullets,
  formatXmlFragment,
  sanitizeDescription,
} from "../../tools/scripts/lib/changelog/xml";

describe("extractBullets", () => {
  it("keeps English bullets and skips translated items", () => {
    expect(
      extractBullets(
        '<ul><li>Fixed a &amp; b.</li><li xml:lang="zh-CN">修复。</li><li>Added x.</li></ul>'
      )
    ).toEqual(["Fixed a & b.", "Added x."]);
  });
});

it("strips nested tags until the text is stable", () => {
  expect(extractBullets("<ul><li>Hello <scr<script>ipt>world</script></li></ul>")).toEqual([
    "Hello ipt>world",
  ]);
});

describe("sanitizeDescription", () => {
  it("escapes a bare ampersand and keeps well-formed markup", () => {
    expect(sanitizeDescription('<ul><li>A & B</li><li xml:lang="zh-CN">中文</li></ul>')).toBe(
      '<description><ul><li>A &amp; B</li><li xml:lang="zh-CN">中文</li></ul></description>'
    );
  });
});

describe("formatXmlFragment", () => {
  it("indents one element per line", () => {
    expect(
      formatXmlFragment(
        '<release version="1"><description><ul><li>x</li></ul></description></release>',
        "  "
      )
    ).toBe(
      [
        '  <release version="1">',
        "    <description>",
        "      <ul>",
        "        <li>x</li>",
        "      </ul>",
        "    </description>",
        "  </release>",
      ].join("\n")
    );
  });
});

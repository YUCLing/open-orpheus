// Generates the release changelog via DeepSeek and updates all three package
// changelog formats from one response:
//   - packaging/flatpak/metainfo.xml        (AppStream <release>)
//   - packaging/resources/debian/changelog  (Debian changelog entry)
//   - packaging/resources/rpm.changelog     (rpm %changelog entries)
//
// Usage:
//   DEEPSEEK_API_KEY=... node scripts/generate-changelog.ts \
//     --notes <release-notes.md> --version <version>
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";

const projectRoot = resolve(import.meta.dirname, "..");

const argv = process.argv.slice(2);
const flagValue = (flag: string) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const notesFile = flagValue("--notes");
const version = flagValue("--version");
if (!notesFile || !version) {
  throw new Error(
    "Usage: generate-changelog.ts --notes <release-notes.md> --version <version>"
  );
}
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY env var.");

const pkg = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf-8")
);
const maintainer =
  typeof pkg.author === "string"
    ? pkg.author
    : `${pkg.author?.name ?? ""} <${pkg.author?.email ?? ""}>`;

const notes = await readFile(notesFile, "utf-8");

const SYSTEM_PROMPT = `You are a release note writer for a Linux desktop app called Open Orpheus (an open-source Netease Cloud Music client). Given GitHub auto-generated release notes, produce a concise, organized summary in English and Chinese. AppStream requires translating individual <li/> items, not whole <ul/> groups. So use a SINGLE <ul> where each English <li> is immediately followed by its Chinese translation as <li xml:lang="zh-CN">. Example: <ul><li>Fixed cookie expiration time.</li><li xml:lang="zh-CN">修复 Cookie 过期时间。</li></ul>. Only describe changes actually present in the notes — never invent features. If the notes are empty or contain nothing meaningful (e.g., only a version bump), only mention: <ul><li>Version bump.</li><li xml:lang="zh-CN">版本更新。</li></ul>. Output ONLY valid JSON: {"description": "<ul>...</ul>"}`;

const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: notes },
    ],
  }),
});
if (!resp.ok) {
  throw new Error(`DeepSeek API returned ${resp.status}: ${await resp.text()}`);
}
const data = (await resp.json()) as {
  choices: Array<{ message: { content: string } }>;
};
const raw = (data.choices[0]?.message.content ?? "").trim();
// The model may wrap the JSON in a ```json fenced block.
const fence = raw.match(/```(?:json)?\s*\n?(.*?)\n?```/s);
const description: string = JSON.parse(fence ? fence[1] : raw).description;

// --- Helpers ---
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const now = new Date();
// e.g. Thu, 28 Aug 2026 00:00:00 +0000 (Debian)
const debianDate = `${WEEKDAYS[now.getUTCDay()]}, ${String(
  now.getUTCDate()
).padStart(
  2,
  "0"
)} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()} 00:00:00 +0000`;
// e.g. Thu Aug 28 2026 (rpm)
const rpmDate = `${WEEKDAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()} ${now.getUTCFullYear()}`;
const isoDate = now.toISOString().slice(0, 10);

// English-only bullets (skip translated <li xml:lang="…"> items) for the
// plain-text Debian/RPM changelogs.
function extractBullets(html: string): string[] {
  const bullets: string[] = [];
  for (const m of html.matchAll(/<li([^>]*)>(.*?)<\/li>/gs)) {
    const lang = /xml:lang=["']([^"']*)["']/i.exec(m[1])?.[1];
    if (lang && !lang.toLowerCase().startsWith("en")) continue;
    bullets.push(
      m[2]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim()
        .replace(/\s+/g, " ")
    );
  }
  return bullets;
}

const escapeXmlText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Parse a description fragment; returns the root element or null on failure. */
function parseDescription(html: string): Element | null {
  try {
    const doc = new DOMParser().parseFromString(
      `<description>${html}</description>`,
      "text/xml"
    );
    const root = doc.documentElement;
    return root && root.nodeName !== "parsererror" ? root : null;
  } catch {
    return null;
  }
}

/**
 * Validate + normalize the DeepSeek description through a real XML parser
 * (@xmldom/xmldom), guaranteeing well-formed, correctly-escaped markup. Falls
 * back to plain escaped text if the model's markup is malformed.
 */
function sanitizeDescription(description: string): string {
  // A bare `&` is the only thing that would make an otherwise-tagged fragment
  // unparseable; escape it first, preserving existing entities.
  const preEscaped = description.replace(
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g,
    "&amp;"
  );
  const root = parseDescription(preEscaped);
  if (!root) {
    return `<description>${escapeXmlText(
      preEscaped.replace(/<[^>]*>/g, "")
    )}</description>`;
  }
  return new XMLSerializer().serializeToString(root);
}

// Pretty-print an XML fragment (one element per line, nested indent) to match
// the existing metainfo.xml formatting.
function formatXmlFragment(fragment: string, indent: string): string {
  let depth = 0;
  return fragment
    .replace(/></g, ">\n<")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const closes = (line.match(/<\//g) ?? []).length;
      const opens = (line.match(/<(?![!?/])/g) ?? []).length;
      if (closes > opens) depth -= closes - opens;
      const out = indent + "  ".repeat(depth) + line;
      if (opens > closes) depth += opens - closes;
      return out;
    })
    .join("\n");
}

// --- 1. metainfo.xml: insert a new <release> at the top of <releases> ---
const metainfoPath = resolve(projectRoot, "packaging/flatpak/metainfo.xml");
const metainfo = await readFile(metainfoPath, "utf-8");
const releaseBlock = formatXmlFragment(
  [
    `<release version="${version}" date="${isoDate}">`,
    `  <url type="details">https://github.com/YUCLing/open-orpheus/releases/tag/v${version}</url>`,
    `  ${sanitizeDescription(description)}`,
    `</release>`,
  ].join("\n"),
  "    "
);
const anchor = /( {2}<releases>\n)/;
if (!anchor.test(metainfo)) {
  throw new Error(
    "Cannot find <releases> in packaging/flatpak/metainfo.xml — aborting."
  );
}
await writeFile(
  metainfoPath,
  metainfo.replace(anchor, `  <releases>\n${releaseBlock}\n`)
);

// --- 2. debian/changelog: prepend an entry ---
const bullets = extractBullets(description);
const debianPath = resolve(projectRoot, "packaging/resources/debian/changelog");
const debian = await readFile(debianPath, "utf-8");
const debianEntry = [
  `open-orpheus (${version}-1) unstable; urgency=medium`,
  "",
  ...bullets.map((b) => `  * ${b}`),
  "",
  ` -- ${maintainer}  ${debianDate}`,
  "",
].join("\n");
await writeFile(debianPath, debianEntry + "\n" + debian);

// --- 3. rpm.changelog: prepend %changelog entries ---
const rpmPath = resolve(projectRoot, "packaging/resources/rpm.changelog");
let rpmChangelog = "";
try {
  rpmChangelog = await readFile(rpmPath, "utf-8");
} catch {
  // First run — start from an empty changelog.
}
const rpmEntry = [
  `* ${rpmDate} ${maintainer} - ${version}-1`,
  ...bullets.map((b) => `- ${b}`),
  "",
].join("\n");
await writeFile(rpmPath, (rpmEntry + "\n" + rpmChangelog).trimStart());

console.log(`Changelogs updated for v${version} (metainfo, Debian, RPM).`);

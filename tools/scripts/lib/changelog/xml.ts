import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";

/**
 * Remove tag-like sequences until none remain.
 *
 * A single pass can leave a tag behind when removing one tag joins its
 * neighbours into a new one (e.g. `<scr<script>ipt>` -> `<script>`), so repeat
 * until the string stops changing. `js/incomplete-multi-character-sanitization`
 * flags the single-pass form.
 */
function stripTags(value: string): string {
  let previous = "";
  let current = value;
  do {
    previous = current;
    current = current.replace(/<[^>]*>/g, "");
  } while (current !== previous);
  return current;
}

const escapeXmlText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * English-only bullets (skip translated `<li xml:lang="…">` items) for the
 * plain-text Debian/RPM changelogs.
 */
export function extractBullets(html: string): string[] {
  const bullets: string[] = [];
  for (const m of html.matchAll(/<li([^>]*)>(.*?)<\/li>/gs)) {
    const lang = /xml:lang=["']([^"']*)["']/i.exec(m[1])?.[1];
    if (lang && !lang.toLowerCase().startsWith("en")) continue;
    bullets.push(
      stripTags(m[2])
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .trim()
        .replace(/\s+/g, " ")
    );
  }
  return bullets;
}

/** Parse a description fragment; returns the root element or null on failure. */
function parseDescription(html: string): Element | null {
  try {
    const doc = new DOMParser().parseFromString(`<description>${html}</description>`, "text/xml");
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
export function sanitizeDescription(description: string): string {
  // A bare `&` is the only thing that would make an otherwise-tagged fragment
  // unparseable; escape it first, preserving existing entities.
  const preEscaped = description.replace(
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g,
    "&amp;"
  );
  const root = parseDescription(preEscaped);
  if (!root) {
    return `<description>${escapeXmlText(stripTags(preEscaped))}</description>`;
  }
  return new XMLSerializer().serializeToString(root);
}

/**
 * Pretty-print an XML fragment (one element per line, nested indent) to match
 * the existing metainfo.xml formatting.
 */
export function formatXmlFragment(fragment: string, indent: string): string {
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

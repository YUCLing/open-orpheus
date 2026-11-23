import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { extractBullets, formatXmlFragment, sanitizeDescription } from "./xml.ts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ChangelogDates {
  /** e.g. `Thu, 28 Aug 2026 00:00:00 +0000` (Debian). */
  debian: string;
  /** e.g. `Thu Aug 28 2026` (rpm). */
  rpm: string;
  /** e.g. `2026-08-28` (AppStream). */
  iso: string;
}

/** Format the three date spellings the changelog formats use. */
export function formatChangelogDates(now: Date): ChangelogDates {
  return {
    debian: `${WEEKDAYS[now.getUTCDay()]}, ${String(now.getUTCDate()).padStart(
      2,
      "0"
    )} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()} 00:00:00 +0000`,
    rpm: `${WEEKDAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()} ${now.getUTCFullYear()}`,
    iso: now.toISOString().slice(0, 10),
  };
}

export interface UpdateChangelogsOptions {
  projectRoot: string;
  version: string;
  /** The bilingual `<ul>` description returned by the model. */
  description: string;
  /** `Name <email>` used by the Debian/RPM entries. */
  maintainer: string;
  /** Clock override; defaults to the current time. */
  now?: Date;
}

/**
 * Update the AppStream, Debian, and RPM changelogs from one description.
 *
 * Each format is written independently: metainfo gets a new `<release>` at the
 * top of `<releases>`, Debian gets a prepended entry, and RPM gets a prepended
 * `%changelog` entry (starting from an empty file on the first run).
 */
export async function updateChangelogs(options: UpdateChangelogsOptions): Promise<void> {
  const { projectRoot, version, description, maintainer } = options;
  const dates = formatChangelogDates(options.now ?? new Date());
  const bullets = extractBullets(description);

  // 1. metainfo.xml: insert a new <release> at the top of <releases>.
  const metainfoPath = resolve(projectRoot, "tools/packaging/flatpak/metainfo.xml");
  const metainfo = await readFile(metainfoPath, "utf-8");
  const releaseBlock = formatXmlFragment(
    [
      `<release version="${version}" date="${dates.iso}">`,
      `  <url type="details">https://github.com/YUCLing/open-orpheus/releases/tag/v${version}</url>`,
      `  ${sanitizeDescription(description)}`,
      `</release>`,
    ].join("\n"),
    "    "
  );
  const anchor = /( {2}<releases>\n)/;
  if (!anchor.test(metainfo)) {
    throw new Error("Cannot find <releases> in tools/packaging/flatpak/metainfo.xml — aborting.");
  }
  await writeFile(metainfoPath, metainfo.replace(anchor, `  <releases>\n${releaseBlock}\n`));

  // 2. debian/changelog: prepend an entry.
  const debianPath = resolve(projectRoot, "tools/packaging/resources/debian/changelog");
  const debian = await readFile(debianPath, "utf-8");
  const debianEntry = [
    `open-orpheus (${version}-1) unstable; urgency=medium`,
    "",
    ...bullets.map((b) => `  * ${b}`),
    "",
    ` -- ${maintainer}  ${dates.debian}`,
    "",
  ].join("\n");
  await writeFile(debianPath, debianEntry + "\n" + debian);

  // 3. rpm.changelog: prepend %changelog entries.
  const rpmPath = resolve(projectRoot, "tools/packaging/resources/rpm.changelog");
  let rpmChangelog = "";
  try {
    rpmChangelog = await readFile(rpmPath, "utf-8");
  } catch {
    // First run — start from an empty changelog.
  }
  const rpmEntry = [
    `* ${dates.rpm} ${maintainer} - ${version}-1`,
    ...bullets.map((b) => `- ${b}`),
    "",
  ].join("\n");
  await writeFile(rpmPath, (rpmEntry + "\n" + rpmChangelog).trimStart());
}

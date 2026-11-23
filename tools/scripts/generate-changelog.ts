// Generates the release changelog via DeepSeek and updates all three package
// changelog formats from one response:
//   - tools/packaging/flatpak/metainfo.xml        (AppStream <release>)
//   - tools/packaging/resources/debian/changelog  (Debian changelog entry)
//   - tools/packaging/resources/rpm.changelog     (rpm %changelog entries)
//
// Usage:
//   DEEPSEEK_API_KEY=... node tools/scripts/generate-changelog.ts \
//     --notes <release-notes.md> --version <version>
import { readFile } from "node:fs/promises";

import pkg from "../../package.json" with { type: "json" };

import { PROJECT_ROOT } from "../shared/paths.ts";
import { requireFlag } from "../shared/cli.ts";
import { generateDescription } from "./lib/changelog/deepseek.ts";
import { updateChangelogs } from "./lib/changelog/writers.ts";

const argv = process.argv.slice(2);
const notesFile = requireFlag(argv, "--notes");
const version = requireFlag(argv, "--version");

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY env var.");

const maintainer =
  typeof pkg.author === "string"
    ? pkg.author
    : `${pkg.author?.name ?? ""} <${pkg.author?.email ?? ""}>`;

const notes = await readFile(notesFile, "utf-8");
const description = await generateDescription(notes, apiKey);

await updateChangelogs({
  projectRoot: PROJECT_ROOT,
  version,
  description,
  maintainer,
});

console.log(`Changelogs updated for v${version} (metainfo, Debian, RPM).`);

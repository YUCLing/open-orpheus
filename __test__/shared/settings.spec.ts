import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { SETTINGS } from "@shared/settings";
import { SETTINGS_DEFAULTS } from "@shared/settings/defaults";

const ROOT = join(import.meta.dirname, "../..");
const CONSTANTS_FILE = join(ROOT, "src", "shared", "settings", "keys.ts");

/** Code that must reach settings keys through `SETTINGS`, not raw literals. */
const SCANNED_DIRS = ["src", "gui/src"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".svelte", ".js"];

const KEY_VALUES = new Set<string>(Object.values(SETTINGS));

/** A settings key passed as the first argument of a settings-like call. */
const CALL = /\.(?:get|set|getMany|setMany|delete|deleteMany)\(\s*(["'])([^"']+)\1/g;
/** A change/delete listener comparing the event key. */
const EVENT_KEY = /\.key\s*(?:===|!==)\s*(["'])([^"']+)\1/g;

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      return SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
    })
  );
  return nested.flat();
}

/** Settings keys still written as bare strings in `text`. */
function findLiteralKeys(text: string): string[] {
  return [...text.matchAll(CALL), ...text.matchAll(EVENT_KEY)]
    .map((match) => match[2])
    .filter((key) => KEY_VALUES.has(key));
}

describe("settings keys", () => {
  it("uses Chromium's k prefix for every constant", () => {
    expect(Object.keys(SETTINGS).filter((name) => !name.startsWith("k"))).toEqual([]);
  });

  it("declares exactly one default per constant", () => {
    expect(Object.keys(SETTINGS_DEFAULTS).sort()).toEqual(Object.values(SETTINGS).sort());
  });

  it("keeps persisted values stable and unique", () => {
    // These strings are the on-disk contract (`settings` namespace in sqlite)
    // and the settings IPC contract. Changing one orphans existing user data,
    // so the list is pinned here rather than only in `keys.ts`.
    expect(new Set(Object.values(SETTINGS)).size).toBe(Object.values(SETTINGS).length);
    expect(Object.values(SETTINGS).sort()).toEqual([
      "audio.currentDevice",
      "desktopLyrics.interpolatedLyricLine",
      "desktopLyrics.opacity",
      "discordPresence.enabled",
      "plugins.enabled",
      "proxy",
      "tray.clickBehavior",
      "update.autoInstall",
      "window.lifecycle",
      "window.overrideMainWindowSizeLimit",
    ]);
  });

  it("has no raw key literals outside the constants module", async () => {
    const offenders: string[] = [];

    for (const dir of SCANNED_DIRS) {
      for (const file of await collectSourceFiles(join(ROOT, dir))) {
        if (file === CONSTANTS_FILE) continue;
        const keys = findLiteralKeys(await readFile(file, "utf8"));
        if (keys.length > 0) offenders.push(`${relative(ROOT, file)}: ${keys.join(", ")}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

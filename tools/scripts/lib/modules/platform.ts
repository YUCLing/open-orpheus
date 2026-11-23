/**
 * Resolve a module script name for the current platform.
 *
 * Modules may declare platform-specific variants of a script by appending
 * `:${process.platform}` — e.g. `build:linux` next to `build`. The variant wins
 * when present, so a module can opt into napi's prebuilt cross toolchain on
 * Linux (`--use-napi-cross`) while every other platform keeps the plain script.
 *
 * Pass `allowPlatformVariant: false` when the caller builds inside a sandbox
 * that already provides the native toolchain (Flatpak) and the cross variant
 * must not be selected.
 *
 * Returns undefined when neither the variant nor the bare script exists.
 */
export function resolvePlatformScript(
  scripts: Record<string, string>,
  base: string,
  allowPlatformVariant = true
): string | undefined {
  const candidates = allowPlatformVariant ? [`${base}:${process.platform}`, base] : [base];
  return candidates.find((name) => scripts[name]);
}

/**
 * Checks whether a module's `os` field is compatible with the given platform,
 * following npm's semantics:
 * - missing/empty list => compatible everywhere
 * - entries prefixed with `!` are negations (always incompatible if matched)
 * - positive entries restrict compatibility to those platforms
 */
export function isPlatformCompatible(os: string[] | undefined, platform: string): boolean {
  if (!os || os.length === 0) return true;
  const negated = new Set(
    os.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1))
  );
  const positive = os.filter((entry) => !entry.startsWith("!"));
  if (negated.has(platform)) return false;
  if (positive.length > 0 && !positive.includes(platform)) return false;
  return true;
}

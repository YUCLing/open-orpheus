import { normalize } from "node:path";

import { app } from "electron";

import { fileExists } from "./utils/fs";
import { isMusicFile } from "./utils/music";

export async function raceArgument<T>(
  predicate: (arg: string, index: number, array: string[]) => Promise<T | null> | T | null,
  argv?: string[]
): Promise<T | null> {
  const args = argv ?? process.argv.slice(app?.isPackaged ? 1 : 2);
  if (args.length === 0) return null;

  try {
    return await Promise.any(
      args.map(async (arg, i, arr) => {
        const result = await predicate(arg, i, arr);
        if (result === null) throw new Error(`No match: ${arg}`);
        return result;
      })
    );
  } catch {
    return null;
  }
}

export function parseMoveRun(arg: string, index: number, array: string[]): [string, string] | null {
  return arg === "--moverun" && array.length > index + 2
    ? // [src, dest]
      [array[index + 1], array[index + 2]]
    : null;
}

export function parseWebCommand(arg: string): string | null {
  return arg.startsWith("orpheus://") ? arg : null;
}

/**
 * Whether a path is a local file this app should open.
 *
 * The checks are imported, not injected. They are leaf utilities whose fakes
 * would only ever return a constant, and the fs probe is what makes this
 * predicate lose the race in `raceArgument` — a property worth exercising for
 * real rather than supplying.
 */
export async function parseLocalFile(arg: string): Promise<string | null> {
  const path = normalize(arg);
  return isMusicFile(path) && (await fileExists(path)) ? path : null;
}

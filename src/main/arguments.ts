import { normalize } from "node:path";

import { app } from "electron";
import { fileExists, isMusicFile } from "./util";

export async function raceArgument<T>(
  predicate: (
    arg: string,
    index: number,
    array: string[]
  ) => Promise<T | null> | T | null,
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

export function parseMoveRun(
  arg: string,
  index: number,
  array: string[]
): [string, string] | null {
  return arg === "--moverun" && array.length > index + 2
    ? // [src, dest]
      [array[index + 1], array[index + 2]]
    : null;
}

export function parseWebCommand(arg: string): string | null {
  return arg.startsWith("orpheus://") ? arg : null;
}

export async function parseLocalFile(arg: string): Promise<string | null> {
  const path = normalize(arg);
  return isMusicFile(path) && (await fileExists(path)) ? path : null;
}

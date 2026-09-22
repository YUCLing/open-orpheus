import { stat } from "node:fs/promises";

import type { OnlineStreamer } from "../audio/OnlineStreamer";
import type { Av3aM4aSource } from "./Av3aM4aSession";

/**
 * `Av3aM4aSource` for a fully-present local file: the whole file is always
 * available, so the frontier is the full size and `ensureRange` is a no-op.
 * The decode utility process reads the file path directly.
 */
export async function localAv3aSource(path: string): Promise<Av3aM4aSource> {
  const { size } = await stat(path);
  return {
    path,
    totalLength: size,
    prefixEnd: () => size,
    ensureRange: async () => {},
  };
}

/**
 * Adapts an `OnlineStreamer` (a progressively downloaded sparse temp file)
 * to the `Av3aM4aSource` the decode session paces against.
 */
export function onlineStreamerToAv3aSource(
  streamer: OnlineStreamer
): Av3aM4aSource {
  return {
    get path(): string {
      return streamer.tempFilePath;
    },
    get totalLength(): number {
      return streamer.totalLength;
    },
    prefixEnd: () => streamer.downloadedPrefixEnd(),
    ensureRange: (start, end, signal) =>
      streamer.ensureRangeDownloaded(start, end, signal),
  };
}

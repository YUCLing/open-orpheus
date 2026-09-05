import type { OnlineStreamer } from "../audio/OnlineStreamer";
import type { Av3aM4aSource } from "./Av3aM4aSession";

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

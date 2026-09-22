import os from "node:os";

import { toError } from "@shared/util";
import { events as lifecycleEvents } from "./lifecycle";
import type { MainWindowAccessor } from "../bootstrap/types";
import { resolveCoverUrl } from "../domain/playback/artwork";
import PlaybackController from "../domain/playback/PlaybackController";
import { PlaybackChange, TrackInfo } from "../domain/playback/types";
import {
  MediaSessionAdapter,
  NoopAdapter,
} from "../domain/playback/adapters/MediaSessionAdapter";
import PlayerCommandRouter from "../domain/playback/PlayerCommandRouter";

/**
 * Track metadata passed through the frozen `player.setInfo` seam.
 *
 * Album art is deliberately not part of this seam: it is reported separately,
 * per song, through `player.setCover` (see {@link mediaSession.setCover}).
 */
export interface Metadata {
  id: string;
  title: string;
  artist: string;
  album: string;
}

/** Single source of truth for playback state (see playback/PlaybackController). */
export const playbackController = new PlaybackController();

let adapter: MediaSessionAdapter = new NoopAdapter();

// Album-art state for the current song. `player.setCover` carries no track id;
// a playId uniquely identifies one song, so the cover is only cleared when a
// different playId arrives in `setMetadata`. It is delivered to the OS session
// separately from the track metadata (see {@link mediaSession.setCover}).
let currentId: string | null = null;

/** Build the `TrackInfo` pushed to the controller for the current metadata. */
function toTrackInfo(metadata: Metadata | null): TrackInfo | null {
  if (!metadata) return null;
  return {
    id: metadata.id,
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
  };
}

/**
 * Load and construct a platform media-session adapter. Media integration is an
 * optional feature: when the platform session is unavailable (e.g. no D-Bus
 * session on Linux) this logs diagnostics and degrades to a no-op adapter
 * instead of letting `createMediaSession` reject and abort startup.
 */
async function loadAdapter(
  load: () => Promise<{ default: new () => MediaSessionAdapter }>,
  name: string
): Promise<MediaSessionAdapter> {
  try {
    return new (await load()).default();
  } catch (err) {
    LOGGER.warn(
      { err: toError(err) },
      "Media session integration (%s) failed to initialize; using a no-op adapter",
      name
    );
    return new NoopAdapter();
  }
}

export interface MediaSessionDeps {
  windows: MainWindowAccessor;
}

export async function createMediaSession(
  deps: MediaSessionDeps
): Promise<void> {
  switch (os.platform()) {
    case "linux":
      // MPRIS is Linux-only (`@open-orpheus/dbus`); load the adapter only here.
      // Constructing it registers a D-Bus name and throws when the session bus
      // is unavailable — `loadAdapter` degrades gracefully instead of aborting.
      adapter = await loadAdapter(
        () => import("../domain/playback/adapters/MprisAdapter"),
        "MPRIS"
      );
      break;
    case "win32":
      // `@open-orpheus/smtc` is a Windows-only native module, so it is only
      // loaded on this platform (kept out of other platform bundles).
      adapter = await loadAdapter(
        () => import("../domain/playback/adapters/SmtcAdapter"),
        "SMTC"
      );
      break;
    case "darwin":
      // `@open-orpheus/nowplaying` is a macOS-only native module (MPNowPlayingInfoCenter).
      adapter = await loadAdapter(
        () => import("../domain/playback/adapters/NowPlayingAdapter"),
        "NowPlaying"
      );
      break;
    default:
      LOGGER.warn("Media session is not available on this platform.");
  }

  // OS media-session commands → renderer.
  new PlayerCommandRouter(adapter, playbackController, deps.windows);

  // Derived state → OS media-session adapter.
  playbackController.on("trackchanged", ({ data }) => adapter.onTrack(data));
  playbackController.on("coverchanged", ({ data }) => adapter.onArtwork(data));
  playbackController.on("statuschanged", ({ data }) => adapter.onStatus(data));
  playbackController.on("positionchanged", ({ data }) =>
    adapter.onPosition(data.position, data.seeked)
  );
  playbackController.on("durationchanged", ({ data }) =>
    adapter.onDuration(data)
  );
  playbackController.on("ratechanged", ({ data }) => adapter.onRate(data));
  playbackController.on("volumechanged", ({ data }) => adapter.onVolume(data));
}

// Frozen seams: `player.setInfo` (registerCallHandler) calls `setMetadata`;
// `player.setCover` (registerCallHandler) calls `setCover`.
export const mediaSession = {
  /**
   * Track metadata for the current song. The renderer calls this twice per song
   * change — once before and once after `player.setCover` — so a cover attached
   * by {@link setCover} must survive a same-id `setMetadata`. The cover is
   * cleared only when a different playId arrives (one playId = one song).
   */
  setMetadata(metadata: Metadata | null): void {
    const nextId = metadata?.id ?? null;
    if (nextId !== currentId) {
      // Different playId (or stop): the previous song's cover no longer applies.
      currentId = nextId;
      playbackController.applyCover(null);
    }
    playbackController.setTrack(toTrackInfo(metadata));
  },

  /**
   * Album art for the current song (`player.setCover`). The raw URL is resolved
   * into something the OS media sessions can consume (a remote URL passes
   * through; an `orpheus://localmusic/pic?<path>` cover is extracted to a local
   * `file://` file), then pushed to the adapters as an art-only update — it is
   * not a track change.
   */
  async setCover(rawUrl: string | null): Promise<void> {
    const id = currentId;
    if (id === null) return; // no track known yet
    const resolved = await resolveCoverUrl(rawUrl, id);
    if (id !== currentId) return; // a different playId arrived while resolving
    playbackController.applyCover(resolved);
  },
};

lifecycleEvents.on("mainwindowcreated", ({ data: mainWindow }) => {
  mainWindow.webContents.ipc.on("player.timeupdate", (e, time) => {
    playbackController.applyPosition(time);
  });

  mainWindow.webContents.ipc.on("player.seeked", (e, time) => {
    playbackController.applyPosition(time, true);
  });

  mainWindow.webContents.ipc.on("player.durationchange", (e, duration) => {
    playbackController.applyDuration(duration);
  });

  mainWindow.webContents.ipc.on("player.playbackratechange", (e, rate) => {
    playbackController.applyRate(rate);
  });

  mainWindow.webContents.ipc.on("player.playbackchange", (e, change) => {
    playbackController.applyPlaybackChange(change as PlaybackChange);
  });

  mainWindow.webContents.ipc.on("player.volumechange", (e, volume) => {
    playbackController.applyVolume(volume);
  });
});

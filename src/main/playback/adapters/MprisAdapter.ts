import Emittery from "emittery";

import {
  MediaSession,
  PlaybackStatus as DbusPlaybackStatus,
} from "@open-orpheus/dbus";

import type { MprisMetadata } from "@open-orpheus/dbus";
import { client } from "../../request";
import { imageSize } from "../../../util";
import {
  artworkFileExists,
  artworkFileUrl,
  cacheArtwork,
  remoteArtExt,
} from "../artwork";
import { PlaybackStatus, TrackInfo } from "../types";
import {
  MediaSessionAdapter,
  PlayerCommandEvents,
} from "./MediaSessionAdapter";

// MPRIS uses microseconds, and we use seconds.
const TIME_RATIO = 1_000_000;

/** Square size to request for album art (instead of the original image). */
const ARTWORK_SIZE = 512;

/** Linux MPRIS integration, backed by the `@open-orpheus/dbus` zbus module. */
export default class MprisAdapter
  extends Emittery<PlayerCommandEvents>
  implements MediaSessionAdapter
{
  private mediaSession: MediaSession;

  private metadata: TrackInfo | null = null;
  private artUrl: string | null = null;
  private status: PlaybackStatus = PlaybackStatus.Stopped;
  private position: number | null = null;
  private duration: number | null = null;
  private rate = 1;
  /**
   * The most recent MPRIS volume write, keyed by the value it was for. The
   * native write is asynchronous, so `SetVolume` awaits the write for *its*
   * value once the renderer has confirmed that value — a write triggered by
   * some other (concurrent or in-app) change must not be mistaken for it.
   */
  private volumeApplied: { volume: number; write: Promise<unknown> } | null =
    null;

  constructor() {
    super();

    let mprisName = "open-orpheus";
    let desktopEntry = "open-orpheus";
    if (process.env.FLATPAK_ID) {
      mprisName = desktopEntry = process.env.FLATPAK_ID;
    }

    this.mediaSession = new MediaSession(
      mprisName,
      "Open Orpheus",
      desktopEntry
    );

    this.mediaSession.setEventHandler(async (err, event) => {
      switch (event.type) {
        case "Play":
          await this.emit("play");
          break;
        case "Pause":
          await this.emit("pause");
          break;
        case "Next":
          await this.emit("next");
          break;
        case "Previous":
          await this.emit("previous");
          break;
        case "Seek":
          await this.emit("seek", event.delta / TIME_RATIO);
          break;
        case "SetPosition":
          await this.emit("setPosition", event.position / TIME_RATIO);
          break;
        case "SetVolume": {
          try {
            await this.emit("volume", event.volume);
          } catch {
            // The router rejects when the renderer never confirms the value; a
            // rejected handler becomes a D-Bus error, so the client learns the
            // request failed rather than waiting forever.
            throw new Error(
              `MPRIS volume change to ${event.volume} was not confirmed by the renderer`
            );
          }
          // The renderer confirmed this exact value, so `onVolume` has already
          // recorded the matching MPRIS write; awaiting it keeps the reply
          // behind the property actually changing.
          const applied = this.volumeApplied;
          if (applied?.volume === event.volume) await applied.write;
          break;
        }
      }
    });
  }

  onTrack(track: TrackInfo | null): void {
    this.metadata = track;
    this.artUrl = null; // album art for a new song arrives separately (onArtwork)
    if (!track) {
      this.mediaSession.setMetadata(null);
      return;
    }
    this.pushMetadata();
  }

  onStatus(status: PlaybackStatus): void {
    this.status = status;
    this.pushPlaybackState();
  }

  onPosition(position: number, seeked: boolean): void {
    this.position = position;
    this.pushPlaybackState();
    if (seeked) {
      this.mediaSession.sendSeeked(position * TIME_RATIO);
    }
  }

  onDuration(duration: number | null): void {
    this.duration = duration;
    this.pushMetadata();
  }

  onRate(rate: number): void {
    this.rate = rate;
    this.pushPlaybackState();
  }

  onVolume(volume: number): void {
    this.volumeApplied = {
      volume,
      write: this.mediaSession.setVolume(volume) as Promise<unknown>,
    };
  }

  dispose(): void {
    this.mediaSession.setMetadata(null);
    this.mediaSession.setEventHandler(null);
  }

  private pushMetadata(): void {
    if (!this.metadata) return;
    const metadata: MprisMetadata = {
      trackId: `/com/163/music/${this.metadata.id}`,
      title: this.metadata.title,
      artist: [this.metadata.artist],
      album: this.metadata.album,
      artUrl: this.artUrl || undefined,
      length: this.duration ? this.duration * TIME_RATIO : undefined,
    };
    this.mediaSession.setMetadata(metadata);
  }

  /**
   * Album art for the current song (`player.setCover`). The URL is already
   * resolved to something the OS can consume: a local `file://` (embedded art
   * of local music) or a remote http(s) URL.
   */
  onArtwork(artUrl: string | null): void {
    if (!this.metadata) return; // no current song
    if (!artUrl) {
      this.artUrl = null;
      this.pushMetadata();
      return;
    }
    const id = this.metadata.id;
    void this.refreshArtwork(id, artUrl);
  }

  private async refreshArtwork(id: string, artUrl: string): Promise<void> {
    const fileUrl = await this.cacheArtworkLocally(id, artUrl);
    if (this.metadata?.id !== id) return; // a different playId meanwhile
    this.artUrl = fileUrl;
    this.pushMetadata();
  }

  private async cacheArtworkLocally(
    id: string,
    artUrl: string
  ): Promise<string> {
    // Already local (embedded art extracted by the media-session layer).
    if (artUrl.startsWith("file://")) return artUrl;
    // Fetch a reasonably-sized thumbnail instead of the original (potentially
    // huge) image — MPRIS clients only ever display a small square.
    const downloadUrl = resizedArtUrl(artUrl);
    const ext = remoteArtExt(downloadUrl);
    // Reuse the cached file if the art for this song was already downloaded.
    if (await artworkFileExists(id, ext)) {
      return artworkFileUrl(id, ext);
    }
    try {
      const response = await client.get(downloadUrl, {
        responseType: "buffer",
      });
      return await cacheArtwork(id, response.body, ext);
    } catch {
      // Download failed; keep the (resized) remote URL so artwork still works.
      return downloadUrl;
    }
  }

  private pushPlaybackState(): void {
    if (this.position === null) return;
    this.mediaSession.updatePlaybackState({
      status: toDbusStatus(this.status),
      position: this.position * TIME_RATIO,
      speed: this.rate,
    });
  }
}

/**
 * Art URL resized to a square thumbnail suitable for media controls. Falls
 * back to the original URL if it isn't a usable CDN URL.
 */
function resizedArtUrl(url: string): string {
  try {
    return imageSize(url, ARTWORK_SIZE);
  } catch {
    return url;
  }
}

function toDbusStatus(status: PlaybackStatus): DbusPlaybackStatus {
  switch (status) {
    case PlaybackStatus.Playing:
      return DbusPlaybackStatus.Playing;
    case PlaybackStatus.Paused:
      return DbusPlaybackStatus.Paused;
    case PlaybackStatus.Stopped:
      return DbusPlaybackStatus.Stopped;
  }
}

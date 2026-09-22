import Emittery from "emittery";

import { MediaSession } from "@open-orpheus/nowplaying";
import { nativeArtUrl } from "../artwork";
import { PlaybackStatus, TrackInfo } from "../types";
import {
  MediaSessionAdapter,
  PlayerCommandEvents,
} from "./MediaSessionAdapter";

/** macOS Now Playing integration, backed by the `@open-orpheus/nowplaying` module. */
export default class NowPlayingAdapter
  extends Emittery<PlayerCommandEvents>
  implements MediaSessionAdapter
{
  private mediaSession: MediaSession;

  private track: TrackInfo | null = null;
  private artUrl: string | null = null;
  private position: number | null = null;
  private duration: number | null = null;
  private rate = 1;

  constructor() {
    super();
    this.mediaSession = new MediaSession();

    this.mediaSession.setEventHandler((err, event) => {
      switch (event.type) {
        case "Play":
          this.emit("play");
          break;
        case "Pause":
          this.emit("pause");
          break;
        case "Toggle":
          this.emit("toggle");
          break;
        case "Next":
          this.emit("next");
          break;
        case "Previous":
          this.emit("previous");
          break;
        case "SetPosition":
          this.emit("setPosition", event.position);
          break;
        case "SetRate":
          // OS-initiated rate change needs a renderer command; ignored in v1.
          break;
      }
    });
  }

  onTrack(track: TrackInfo | null): void {
    this.track = track;
    this.artUrl = null; // album art arrives separately via onArtwork
    this.pushMetadata();
  }

  onArtwork(artUrl: string | null): void {
    if (!this.track) return; // no current song
    this.artUrl = artUrl;
    this.pushMetadata();
  }

  onStatus(status: PlaybackStatus): void {
    this.mediaSession.setPlaybackState(status);
    this.pushMetadata();
  }

  onPosition(position: number): void {
    this.position = position;
    this.pushMetadata();
  }

  onDuration(duration: number | null): void {
    this.duration = duration;
    this.pushMetadata();
  }

  onRate(rate: number): void {
    this.rate = rate;
    this.pushMetadata();
  }

  onVolume(): void {
    // Now Playing has no volume concept.
  }

  dispose(): void {
    this.mediaSession.setMetadata(null);
    this.mediaSession.setEventHandler(null);
  }

  // Always send the full snapshot (the native dict is fully replaced). The
  // native module loads the album art directly from the `artUrl` URL via
  // `NSImage initWithContentsOfURL:`.
  private pushMetadata(): void {
    this.mediaSession.setMetadata(
      this.track
        ? {
            title: this.track.title,
            artist: this.track.artist,
            album: this.track.album,
            duration: this.duration ?? undefined,
            elapsed: this.position ?? undefined,
            rate: this.rate,
            artUrl: this.artUrl ? nativeArtUrl(this.artUrl) : undefined,
          }
        : null
    );
  }
}

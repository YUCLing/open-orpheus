import Emittery from "emittery";

import { MediaSession, PlaybackStatus } from "@open-orpheus/dbus";

import type {
  IMediaSession,
  MediaSessionEvents,
  Metadata,
} from "../mediaSession";

// MPRIS uses microseconds, and we use seconds
const TIME_RATIO = 1000000;

export default class MprisMediaSession
  extends Emittery<MediaSessionEvents>
  implements IMediaSession
{
  private mediaSession: MediaSession;

  private metadata: Metadata | null = null;
  private status: PlaybackStatus = PlaybackStatus.Stopped;
  private position: number | null = null;
  private duration: number | null = null;
  private rate = 1;

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

    this.mediaSession.setEventHandler((err, event) => {
      switch (event.type) {
        case "Play":
          this.emit("play");
          break;
        case "Pause":
          this.emit("pause");
          break;
        case "Next":
          this.emit("next");
          break;
        case "Previous":
          this.emit("previous");
          break;
        case "Seek":
          this.emit("seek", event.delta / TIME_RATIO);
          break;
        case "SetPosition":
          this.emit("position", event.position / TIME_RATIO);
          break;
        case "SetVolume":
          this.emit("volume", event.volume);
          break;
      }
    });
  }
  updatePosition(position: number | null, seeked = false): void {
    this.position = position;
    this.updateMprisPlaybackState();
    if (seeked && position) {
      this.mediaSession.sendSeeked(position * TIME_RATIO);
    }
  }
  updateDuration(duration: number | null): void {
    this.duration = duration;
    this.updateMprisMetadata();
  }
  updateState(state: boolean): void {
    if (this.position === null) {
      this.status = PlaybackStatus.Stopped;
      return;
    }
    this.status = state ? PlaybackStatus.Playing : PlaybackStatus.Paused;
    this.updateMprisPlaybackState();
  }
  updateVolume(volume: number): void {
    this.mediaSession.setVolume(volume);
  }

  private updateMprisPlaybackState() {
    if (this.status === null || this.position === null) return;
    this.mediaSession.updatePlaybackState({
      status: this.status,
      position: this.position * TIME_RATIO,
      speed: this.rate,
    });
  }

  private updateMprisMetadata() {
    if (!this.metadata) return;
    this.mediaSession.setMetadata({
      trackId: `/com/163/music/${this.metadata.id}`,
      title: this.metadata.title,
      artist: [this.metadata.artist],
      album: this.metadata.album,
      artUrl: this.metadata.url,
      length: this.duration ? this.duration * TIME_RATIO : undefined,
    });
  }

  updatePlaybackRate(rate: number): void {
    this.rate = rate;
    this.updateMprisPlaybackState();
  }
  setMetadata(metadata: Metadata): void {
    this.metadata = metadata;
    this.updateMprisMetadata();
  }
}

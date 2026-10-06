import Emittery from "emittery";

import AudioEffectManager from "./AudioEffectManager";
import { Av3aPlaybackBackend } from "./backends/Av3aPlaybackBackend";
import { MediaPlaybackBackend } from "./backends/MediaPlaybackBackend";
import { isAv3aLocalFile } from "./av3a/detect";
import { toError, volumeToGain } from "@shared/util";
import type { PlaybackBackend, PlaybackEventName } from "./PlaybackBackend";

export enum AudioPlayerState {
  Null = 0,
  Playing = 1,
  Paused = 2,
  Error = 3,
}

export type SongInfo = {
  playId: string;
  songName: string;
  artistName: string;
  albumId: string;
  albumName: string;
  songType: string;
  artworkUrl: string;
  cover: string;
  totalTime: number;
  liked: boolean;
};

export type LyricContent = {
  krc: string;
  lrc: string;
  romalrc: string;
  tlrc: string;
  yrc: string;
};

export type PlaylistItem = {
  id: string;
  from: string;
  title: string;
  track_id: string;
  program: unknown | null;
  mv: string;
  album: string;
  artist: string;
  alias: string;
  cloud: number;
};

export type Playlist = {
  items: PlaylistItem[];
  currentPlay: string;
};

export type AudioPlayInfo = {
  playId: string;
  aiprocessorRatio: number;
  destLevel: string;
  songId: string;
  songQuality: "standard" | "exhigh" | "hires" | "jyeffect" | "vivid" | "sky" | "jymaster" | string;
} & (
  | {
      type: 0;
      bitrate: "exhigh" | "hires" | string;
      path: string;
      playbrt: number;
    }
  | {
      type: 4;
      songId: string;
      audioFormat: "m4a" | "flac" | "av3a" | string;
      audioType: "track" | string;
      bitrate: number;
      br: string;
      expireTime: number;
      extHeader: string;
      fileSize: number;
      format: unknown;
      freeTrialInfo: unknown | null;
      freeTrialPrivilege: {
        resConsumable: boolean;
        userConsumable: boolean;
        listenType: unknown | null;
        playReason: unknown | null;
        cannotListenReason: unknown | null;
        freeLimitTagType: unknown | null;
      };
      level: string;
      md5: string;
      playInfoStr: string;
      podcastCtrp: unknown | null;
      rightSource: number;
      songDuration: string;
      musicurl: string;
    }
);

export type PlayerEvents = {
  volumechange: number;
  audiodata: { data: ArrayBuffer; pts: number };
  lyricstyleupdate: { key: string | symbol; value: unknown };
  playinfoupdate: AudioPlayInfo;
  load: { id: string };
  // Media-surface events. Emitted by the active playback backend (media
  // element or AV3A) and re-emitted here with these types.
  play: undefined;
  playing: undefined;
  pause: undefined;
  ended: undefined;
  /** Decode error (Error, AV3A) or a media-element error event. */
  error: Error | Event;
  stalled: undefined;
  seeking: undefined;
  seeked: undefined;
  timeupdate: undefined;
  durationchange: undefined;
  ratechange: undefined;
};

export default class Player extends Emittery<PlayerEvents> {
  private _audioCtx: AudioContext = new AudioContext();
  private _audioEffectManager = new AudioEffectManager(this._audioCtx);
  private _honeyPotPromise: Promise<AudioWorkletNode>;

  // Backends (each owns its engine); `_backend` is whichever is active.
  private _media: MediaPlaybackBackend;
  private _av3a: Av3aPlaybackBackend;
  private _backend: PlaybackBackend;

  private _playInfo: AudioPlayInfo | null = null;
  /**
   * The user's desired playing state: the last explicit transport command
   * (`play`/`pause`/`stop`). Device-change recovery reads it to decide whether
   * an interruption should be undone.
   *
   * Only a transport command writes it, and only before that command awaits.
   * The backend pause a sink change causes is an interruption, not intent, so
   * deriving intent from `paused` mid-switch is what let a second switch erase
   * the intent the first one was going to restore.
   *
   * `_intentSeq` bumps with every command, so a caller that had to await can
   * tell that a newer command took over while it waited.
   */
  private _desiredPlayingState = false;
  private _intentSeq = 0;
  /**
   * Sink switches currently awaiting `setSinkId`. Overlapping switches observe
   * the same transient pause, so only the last one to settle restores playback
   * (an earlier one would resume in the middle of a newer device change).
   */
  private _sinkSwitchesInFlight = 0;
  private _volume = 1;
  /**
   * Monotonic sequence for `load` requests; only the newest request may win.
   * Sniffing (local format detection) and engine disposal are async, so an
   * older request could otherwise resume after a newer one finished and
   * overwrite it (stale load replacing the freshly chosen song). Each `load`
   * claims a sequence at entry and drops itself once stale, checked at every
   * await boundary before it mutates state or notifies main.
   */
  private loadRequestSeq = 0;

  // #region Getters & Setters
  get audioContext() {
    return this._audioCtx;
  }

  get currentTime(): number {
    return this._backend.currentTime;
  }
  set currentTime(value: number) {
    this._backend.seek(value);
  }

  get duration(): number {
    return this._backend.duration;
  }

  get paused(): boolean {
    return this._backend.paused;
  }

  get ended(): boolean {
    return this._backend.ended;
  }

  get playbackRate(): number {
    return this._backend.playbackRate;
  }
  set playbackRate(value: number) {
    this._backend.setPlaybackRate(value);
  }

  get isAv3aActive(): boolean {
    return this._backend === this._av3a;
  }

  get gainNode() {
    return this._audioEffectManager.output;
  }

  get currentId() {
    return this._playInfo?.playId ?? "";
  }

  get currentPlayInfo() {
    return this._playInfo;
  }

  get volume() {
    return this._volume;
  }
  set volume(value: number) {
    this._volume = value;
    // TODO: Maybe allow user to custom minimal dB value in the future
    this.gainNode.gain.value = volumeToGain(value);
    void this.emit("volumechange", value);
  }

  get replayGain() {
    return this._audioEffectManager.input;
  }

  /**
   * The audio effect manager of the player.
   *
   * Note that its input is currently being used as replay gain, and
   * its output is currently being used as volume gain.
   */
  get audioEffectManager() {
    return this._audioEffectManager;
  }
  // #endregion

  constructor() {
    super();

    this._media = new MediaPlaybackBackend(this._audioCtx, (name, data) =>
      this.onBackendEvent(this._media, name, data)
    );
    this._av3a = new Av3aPlaybackBackend(
      this._audioCtx,
      this._audioEffectManager.input,
      (name, data) => this.onBackendEvent(this._av3a, name, data)
    );
    this._backend = this._media;

    // Both backends feed the shared effect chain; the chain feeds the speakers.
    this._media.sourceNode.connect(this._audioEffectManager.input);
    this._audioEffectManager.output.connect(this._audioCtx.destination);

    // If the context stops on its own, only the media element needs pausing
    // (the AV3A backend already suspends the context as its pause).
    this._audioCtx.addEventListener("statechange", () => {
      if (this._audioCtx.state !== "running" && this._backend === this._media) {
        this._media.pause();
      }
    });

    // Ensure gain stays consistent with volume.
    this.volume = this._volume;

    this._honeyPotPromise = new Promise((resolve, reject) => {
      let attempts = 0;
      const loadHoneypot = () => {
        attempts++;
        this._audioCtx.audioWorklet
          .addModule("audio://worklet/pcm-honeypot.js")
          .then(() => {
            const node = new AudioWorkletNode(this._audioCtx, "pcm-honeypot", {
              numberOfInputs: 1,
              numberOfOutputs: 0,
              channelCount: 2,
              channelCountMode: "explicit",
            });

            node.port.onmessage = (ev) => {
              void this.emit("audiodata", ev.data);
            };

            resolve(node);
          })
          .catch((e) => {
            // Failed, debounce retry 30 times (max 30s, add 1s per attempt)
            if (attempts > 30) {
              reject(e);
              return;
            }
            setTimeout(loadHoneypot, attempts * 1000);
          });
      };

      // Start the initial attempt
      loadHoneypot();
    });
  }

  private async ensureAudioContextState(running = true) {
    if (running && this._audioCtx.state !== "running") {
      await this._audioCtx.resume();
    } else if (!running && this._audioCtx.state === "running") {
      await this._audioCtx.suspend();
    }
  }

  /**
   * Record a transport command as the user's intent and return that intent's
   * epoch. A caller that must await before acting compares the epoch
   * afterwards: a different value means a newer command owns playback, so the
   * caller must not force its now-stale intent onto the backend.
   */
  private claimPlaybackIntent(playing: boolean): number {
    this._desiredPlayingState = playing;
    return ++this._intentSeq;
  }

  /** Whether no transport command has changed the intent since `epoch`. */
  private isIntentCurrent(epoch: number): boolean {
    return epoch === this._intentSeq;
  }

  /**
   * Whether `playInfo` should play through the AV3A decode backend. URL av3a
   * is signalled by `audioFormat`; a local file's codec is not part of the
   * play info, so it is sniffed (in main, which owns `fs`).
   */
  private async resolveAv3a(playInfo: AudioPlayInfo): Promise<boolean> {
    if (playInfo.type === 4) return playInfo.audioFormat === "av3a";
    if (playInfo.type === 0) {
      try {
        return await isAv3aLocalFile(playInfo.path);
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Switch the output device.
   *
   * The switch can transiently suspend the audio context, and `statechange`
   * turns a suspended context into a backend pause, so a device change can stop
   * playback without the user asking. Undo that here, without ever overriding a
   * transport command issued while the switch was in flight.
   */
  async setSinkId(sinkId: string): Promise<void> {
    // Whether playback was running when the switch started. Read now, before
    // the interruption it causes, and never written back as if the transient
    // pause were the user's intent.
    const wasPlaying = !this.paused;
    const intent = this._intentSeq;
    this._sinkSwitchesInFlight += 1;

    return await (this._audioCtx as unknown as HTMLAudioElement)
      .setSinkId(sinkId)
      .finally(async () => {
        this._sinkSwitchesInFlight -= 1;
        // A newer switch is still applying; it may interrupt playback again, so
        // recovery belongs to whichever switch settles last.
        if (this._sinkSwitchesInFlight > 0) return;

        // Either the user wants playback (`_desiredPlayingState` already
        // reflects a pause/stop issued while we waited), or playback was
        // running and no command has touched the intent since. A newer command
        // always wins over the recovery.
        const wantsPlayback =
          this._desiredPlayingState || (wasPlaying && this.isIntentCurrent(intent));
        if (!wantsPlayback || !this.paused) return;

        // We want changing device doesn't pause the playback. A switch that
        // starts while this resume waits for the context takes over instead (see
        // `playWhen`), so playback only starts once the device has settled.
        await this.playWhen(() => this._sinkSwitchesInFlight === 0).catch((e) =>
          LOGGER.warn({ err: toError(e) }, "Failed to resume playback after device change.")
        );
      });
  }

  async load(playInfo: AudioPlayInfo): Promise<void> {
    // Claim the freshness sequence at request entry, before any await, so a
    // newer load can invalidate us while we sniff or dispose.
    const requestSeq = ++this.loadRequestSeq;
    const isStale = () => requestSeq !== this.loadRequestSeq;

    const isAv3a = await this.resolveAv3a(playInfo);
    // A newer load started while we were sniffing; it owns playback now.
    if (isStale()) return;

    const next: PlaybackBackend = isAv3a ? this._av3a : this._media;

    // Switching engines: retire the old one first (stops the decode session or
    // clears a stale media-element source), then delegate to the new one.
    if (next !== this._backend) {
      const previous = this._backend;
      this._backend = next;
      await previous.dispose();
      // A newer load started while we disposed; it owns `_backend` now (it will
      // overwrite it). Drop our tail without notifying main or loading.
      if (isStale()) return;
    }

    this._playInfo = playInfo;
    await this.emit("playinfoupdate", playInfo);
    // A newer load started while we notified main; do not start our engine.
    if (isStale()) return;
    await next.load(playInfo);
  }

  async play() {
    await this.playWhen();
  }

  /**
   * Claim the playback intent, wait for the audio context, then start the
   * backend.
   *
   * The claim happens before the wait, so a pause/stop/play issued meanwhile
   * wins: this call drops out instead of starting a stale play — possibly on a
   * different song. `mayStart` is checked last and covers conditions that are
   * not a change of intent; sink-change recovery uses it to hand a resume over
   * to a switch that started while the context was resuming. That switch
   * re-reads the intent claimed here when it settles, so it restores playback
   * itself and nothing is lost by dropping out.
   */
  private async playWhen(mayStart: () => boolean = () => true) {
    const intent = this.claimPlaybackIntent(true);
    await this.ensureAudioContextState();
    if (!this.isIntentCurrent(intent)) return;
    if (!mayStart()) return;
    await this._backend.play();
  }

  pause() {
    this.claimPlaybackIntent(false);
    this._backend.pause();
  }

  stop() {
    // Invalidating any in-flight load: a `load()` that is awaiting sniff /
    // dispose / play-info notification must not resume and reload the song the
    // user just stopped. Bumping the sequence here makes it stale at its next
    // await boundary, exactly like a newer `load` would.
    this.loadRequestSeq += 1;
    this._playInfo = null;
    this.claimPlaybackIntent(false);
    this._backend.stop();
    // Simply try, does nothing if failed.
    this._honeyPotPromise
      .then((node) => {
        node.port.postMessage("reset");
      })
      .catch(() => {});
  }

  async setAudioDataEnabled(enabled: boolean) {
    const node = await this._honeyPotPromise;
    const source = this._backend.sourceNode;
    if (!source) return;
    if (enabled) {
      source.connect(node);
    } else {
      node.port.postMessage("reset");
      try {
        source.disconnect(node);
      } catch (err) {
        if (err instanceof DOMException && err.name === "InvalidAccessError") return;
        throw err;
      }
    }
  }

  /**
   * Route a media event from `source` into the typed Player event stream, but
   * only when `source` is the currently active backend (so a retired backend's
   * late events never leak through).
   */
  private onBackendEvent(source: PlaybackBackend, name: PlaybackEventName, data?: unknown): void {
    if (source !== this._backend) return;
    switch (name) {
      case "load":
        void this.emit("load", { id: this.currentId });
        break;
      case "error":
        void this.emit("error", data as Error | Event);
        break;
      case "ended":
        // Playback finished on its own, so the user's intent to play is spent:
        // a later device change must not restart the finished track (anything
        // that should follow — repeat, next track — issues its own `play`).
        this.claimPlaybackIntent(false);
        void this.emit("ended");
        break;
      default: {
        // The remaining events carry no payload.
        // Keep this a member call: Emittery's `emit` relies on `this`, so
        // copying it into a local first would lose the receiver.
        void (this.emit as (eventName: PlaybackEventName) => Promise<void>)(name);
        break;
      }
    }
  }
}

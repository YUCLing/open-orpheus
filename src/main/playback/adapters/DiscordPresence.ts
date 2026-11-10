import { isDiscordApplicationId } from "@shared/discordPresence";

import type PlaybackController from "../PlaybackController";
import { PlaybackStatus, type TrackInfo } from "../types";
import DiscordIpc, { type DiscordActivity, type DiscordIpcOptions } from "./DiscordIpc";

const MAX_TEXT_BYTES = 128;
const ABSOLUTE_PATH_OR_URL = /^(?:[~/]\/|\/|[a-z]:[\\/]|\\\\|[a-z][a-z\d+.-]*:\/\/)/i;
const APP_ICON =
  "https://raw.githubusercontent.com/YUCLing/open-orpheus/v0.20.0/assets/icon_256.png";

function presenceText(value: string): string {
  if (typeof value !== "string") return "";
  const text = value.trim().toWellFormed();
  if (ABSOLUTE_PATH_OR_URL.test(text)) return "";

  let bytes = 0;
  let limited = "";
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > MAX_TEXT_BYTES) break;
    limited += character;
  }
  return limited;
}

/** 将正在播放的歌曲同步到 Discord。用户启用前不会创建 IPC 连接。 */
export default class DiscordPresence {
  private readonly unsubscribe: Array<() => void>;
  private positionTrack: TrackInfo | null;
  private advancing: boolean;
  private applicationId = "";
  private ipc: DiscordIpc | null = null;
  private closing = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly playback: PlaybackController,
    private readonly ipcOptions?: DiscordIpcOptions
  ) {
    const { track, position, status } = playback.snapshot;
    this.positionTrack = position === null ? null : track;
    this.advancing = status === PlaybackStatus.Playing;

    const refresh = () => this.ipc?.refresh();
    this.unsubscribe = [
      playback.on("trackchanged", refresh),
      playback.on("statuschanged", refresh),
      playback.on("durationchanged", refresh),
      playback.on("ratechanged", refresh),
      playback.on("advancingchange", ({ data }) => {
        if (this.advancing === data) return;
        this.advancing = data;
        refresh();
      }),
      playback.on("timeupdate", () => {
        // 新曲第一次上报位置时才计算进度，避免使用上一首的进度。
        const { track } = playback.snapshot;
        if (track === this.positionTrack) return;
        this.positionTrack = track;
        refresh();
      }),
      playback.on("positionchanged", ({ data }) => {
        if (!data.seeked) return;
        this.advancing = playback.snapshot.status === PlaybackStatus.Playing;
        refresh();
      }),
    ];
  }

  configure(enabled: boolean, applicationId: string): void {
    if (this.disposed) return;
    const id = applicationId.trim();
    const next = enabled && isDiscordApplicationId(id) ? id : "";
    if (this.applicationId === next) return;
    this.applicationId = next;
    const previous = this.ipc;
    this.ipc = null;
    if (previous) this.closing = previous.close();

    // 同一进程的旧活动必须先清除，再用新 ID 发布，防止误清除新活动。
    void this.closing.then(() => {
      if (!next || this.applicationId !== next || this.ipc) return;
      this.ipc = new DiscordIpc(next, () => this.activity(), this.ipcOptions);
      this.ipc.refresh();
    });
  }

  dispose(): Promise<void> {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.configure(false, "");
    this.disposed = true;
    return this.closing;
  }

  private activity(): DiscordActivity | null {
    const { track, status, position, duration, rate } = this.playback.snapshot;
    if (!track || status !== PlaybackStatus.Playing) return null;
    const title = presenceText(track.title);
    if (!title) return null;

    const artist = presenceText(track.artist);
    const activity: DiscordActivity = {
      type: 2,
      status_display_type: 2,
      details: title,
      assets: { large_image: APP_ICON, large_text: "Open Orpheus" },
    };
    if (artist) activity.state = artist;
    if (
      this.advancing &&
      track === this.positionTrack &&
      position !== null &&
      Number.isFinite(position) &&
      position >= 0 &&
      duration !== null &&
      Number.isFinite(duration) &&
      duration > position &&
      Number.isFinite(rate) &&
      rate > 0
    ) {
      // 本机 RPC 使用 Unix 秒；按实际速度计算剩余时间。
      const now = Date.now() / 1000;
      const start = Math.floor(now - position / rate);
      const end = Math.ceil(now + (duration - position) / rate);
      if (start > 0 && Number.isSafeInteger(end)) activity.timestamps = { start, end };
    }
    return activity;
  }
}

import { Events, RPCClient } from "@discordjs/rpc";
import type PlaybackController from "../PlaybackController";
import { PlaybackStatus, type TrackInfo } from "../types";

const DISCORD_APPLICATION_ID = "1569539057950658691";
const CONNECT_TIMEOUT_MS = 1000;
const ACTIVITY_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 5000;
const CLOSE_TIMEOUT_MS = 250;

const MAX_TEXT_BYTES = 128;
const ABSOLUTE_PATH_OR_URL = /^(?:[~/]\/|\/|[a-z]:[\\/]|\\\\|[a-z][a-z\d+.-]*:\/\/)/i;
const APP_ICON =
  "https://raw.githubusercontent.com/YUCLing/open-orpheus/v0.20.0/assets/icon_256.png";

interface DiscordActivity {
  type: 2;
  status_display_type: 2;
  details: string;
  state?: string;
  timestamps?: { start: number; end: number };
  assets: { large_image: string; large_text: string };
}

interface DiscordIpcOptions {
  retryDelay?: number;
  requestTimeout?: number;
}

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
  private enabled = false;
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

  configure(enabled: boolean): void {
    if (this.disposed) return;
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    const previous = this.ipc;
    this.ipc = null;
    if (previous) this.closing = previous.close();

    // 重新开启前先清除旧连接的活动，避免迟到的清除影响新活动。
    void this.closing.then(() => {
      if (!this.enabled || this.disposed || this.ipc) return;
      this.ipc = new DiscordIpc(() => this.activity(), this.ipcOptions);
      this.ipc.refresh();
    });
  }

  dispose(): Promise<void> {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.configure(false);
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

/** 通过 Discord RPC 库同步最新播放状态，连接和请求均设有超时。 */
class DiscordIpc {
  private client: RPCClient | null = null;
  private desiredActivity: DiscordActivity | null = null;
  // 请求失败时无法确定 Discord 保留了哪次活动，需要重新同步。
  private published: string | null | undefined = null;
  private syncing: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readonly abort = new AbortController();
  private closed = false;

  constructor(
    private readonly activity: () => DiscordActivity | null,
    private readonly options: DiscordIpcOptions = {}
  ) {}

  refresh(): void {
    if (this.closed) return;
    this.desiredActivity = this.activity();
    if (this.syncing || this.retry) return;
    this.syncing = this.sync().finally(() => {
      this.syncing = null;
      const desired = this.desiredActivity;
      if (
        (this.client || desired !== null) &&
        (desired === null ? null : JSON.stringify(desired)) !== this.published
      ) {
        this.refresh();
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.abort.abort();
    const client = this.client;
    this.client = null;
    const signal = AbortSignal.timeout(CLOSE_TIMEOUT_MS);
    await this.syncing;
    if (!client) return;
    try {
      if (client.ready) await client.clearActivity(process.pid, { signal });
    } catch {
      // 退出期间尽力清除活动，超时后继续关闭连接。
    } finally {
      await client.transport.close({ signal }).catch(() => {});
    }
  }

  private async sync(): Promise<void> {
    let client = this.client;
    try {
      if (!client) {
        client = await this.connect();
        if (!client) return;
      }

      while (!this.closed && this.client === client) {
        const activity = this.desiredActivity;
        const next = activity === null ? null : JSON.stringify(activity);
        if (next === this.published) return;
        const signal = AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(this.options.requestTimeout ?? ACTIVITY_TIMEOUT_MS),
        ]);
        if (activity === null) {
          await client.clearActivity(process.pid, { signal });
        } else {
          await client.setActivity({ ...activity }, process.pid, { signal });
        }
        this.published = next;
        LOGGER.debug(
          { operation: activity === null ? "clear" : "publish" },
          "Discord acknowledged a Rich Presence update"
        );
      }
    } catch {
      if (this.closed) return;
      this.published = undefined;
      if (client && !client.ready) {
        if (this.client === client) this.client = null;
        await client.transport
          .close({ signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) })
          .catch(() => {});
      }
      this.scheduleRetry();
    }
  }

  private async connect(): Promise<RPCClient | null> {
    if (this.closed || this.desiredActivity === null) return null;
    const client = new RPCClient();
    this.client = client;
    this.published = null;
    let connected = false;
    client.transport.on("error", () => LOGGER.debug("Discord IPC connection error"));
    client.on(Events.Disconnected, () => {
      // 登录失败交给外层退避重试，连接建立后断开时再安排重连。
      if (!connected || this.client !== client) return;
      this.client = null;
      this.published = null;
      this.scheduleRetry();
    });
    try {
      await client.login(
        { clientId: DISCORD_APPLICATION_ID },
        { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]) }
      );
      if (!client.ready) throw new Error("Discord disconnected during login");
      connected = true;
      return client;
    } catch (error) {
      if (this.client === client) this.client = null;
      await client.transport
        .close({ signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) })
        .catch(() => {});
      throw error;
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry || (!this.client && this.desiredActivity === null)) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.refresh();
    }, this.options.retryDelay ?? RECONNECT_DELAY_MS).unref();
  }
}

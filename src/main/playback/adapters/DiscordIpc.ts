import { Events, RPCClient } from "@discordjs/rpc";

const DISCORD_APPLICATION_ID = "1569539057950658691";
const CONNECT_TIMEOUT_MS = 1000;
const ACTIVITY_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 5000;
const CLOSE_TIMEOUT_MS = 250;

export interface DiscordActivity {
  type: 2;
  status_display_type: 2;
  details: string;
  state?: string;
  timestamps?: { start: number; end: number };
  assets: { large_image: string; large_text: string };
}

export interface DiscordIpcOptions {
  retryDelay?: number;
  requestTimeout?: number;
}

/** 通过 Discord RPC 库同步最新播放状态，连接和请求均设有超时。 */
export default class DiscordIpc {
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
    const attemptedPaths = new Set<string>();
    while (!this.closed && this.desiredActivity !== null) {
      const previousSize = attemptedPaths.size;
      const client = new RPCClient({
        ipcPathFilter: (path) => {
          if (this.closed || this.desiredActivity === null || attemptedPaths.has(path))
            return false;
          attemptedPaths.add(path);
          return true;
        },
      });
      this.client = client;
      this.published = null;
      let connected = false;
      client.transport.on("error", () => LOGGER.debug("Discord IPC connection error"));
      client.on(Events.Disconnected, () => {
        // 握手失败由本轮扫描继续选址，建立连接后才走普通重连。
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
        // 没有新候选意味着本轮已耗尽，由调用方安排退避。
        if (attemptedPaths.size === previousSize) throw error;
      }
    }
    return null;
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry || (!this.client && this.desiredActivity === null)) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.refresh();
    }, this.options.retryDelay ?? RECONNECT_DELAY_MS).unref();
  }
}

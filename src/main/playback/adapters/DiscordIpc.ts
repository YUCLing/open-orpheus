import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { createConnection, Socket } from "node:net";
import { isAbsolute, join } from "node:path";

const HEADER_SIZE = 8;
const MAX_PAYLOAD_SIZE = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 1000;
const ACTIVITY_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 5000;
const CLOSE_TIMEOUT_MS = 250;

enum Opcode {
  Handshake = 0,
  Frame = 1,
  Close = 2,
  Ping = 3,
  Pong = 4,
}

export interface DiscordActivity {
  type: 2;
  status_display_type: 2;
  details: string;
  state?: string;
  timestamps?: { start: number; end: number };
  assets: { large_image: string; large_text: string };
}

export interface DiscordIpcOptions {
  paths?: readonly string[];
  retryDelay?: number;
}

function socketPaths(): string[] {
  const { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } = process.env;
  const flatpakDiscordDir =
    XDG_RUNTIME_DIR && isAbsolute(XDG_RUNTIME_DIR)
      ? join(XDG_RUNTIME_DIR, "app", "com.discordapp.Discord")
      : undefined;
  const directories = new Set([XDG_RUNTIME_DIR, flatpakDiscordDir, TMPDIR, TMP, TEMP, "/tmp"]);
  return [...directories].flatMap((directory) =>
    directory && isAbsolute(directory)
      ? Array.from({ length: 10 }, (_, index) => join(directory, `discord-ipc-${index}`))
      : []
  );
}

function isOwnedSocket(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isSocket() && stat.uid === process.getuid?.();
  } catch {
    return false;
  }
}

function frame(opcode: Opcode, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function jsonFrame(opcode: Opcode, payload: object): Buffer {
  return frame(opcode, Buffer.from(JSON.stringify(payload)));
}

/** 只连接 Discord 的本机 IPC；从不读取账号令牌。 */
export default class DiscordIpc {
  private readonly paths: readonly string[];
  private readonly retryDelay: number;
  private socket: Socket | null = null;
  private ready = false;
  private desiredActivity: DiscordActivity | null = null;
  // 回执超时后无法确定 Discord 保留了哪次活动，下一次需要重新同步。
  private published: string | null | undefined = null;
  private pendingActivity: { nonce: string; value: string | null } | null = null;
  private activityTimeout: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly applicationId: string,
    private readonly activity: () => DiscordActivity | null,
    options: DiscordIpcOptions = {}
  ) {
    this.paths = options.paths ?? socketPaths();
    this.retryDelay = options.retryDelay ?? RECONNECT_DELAY_MS;
  }

  refresh(): void {
    if (this.closed) return;
    this.desiredActivity = this.activity();
    this.flush();
  }

  private flush(): void {
    if (this.closed) return;
    const activity = this.desiredActivity;
    const socket = this.socket;
    if (this.ready && socket && !socket.destroyed) {
      if (this.pendingActivity || this.retry) return;
      const next = activity === null ? null : JSON.stringify(activity);
      if (next !== this.published) {
        socket.write(this.activityFrame(activity, next));
        this.activityTimeout = setTimeout(() => {
          this.clearPendingActivity();
          this.published = undefined;
          this.scheduleRetry();
        }, ACTIVITY_TIMEOUT_MS).unref();
      }
    } else if (activity === null) {
      this.cancelRetry();
      socket?.destroy();
    } else if (!socket && !this.retry) {
      this.connect(0);
    }
  }

  close(): Promise<void> {
    this.closed = true;
    this.cancelRetry();
    const pending = this.pendingActivity;
    this.clearPendingActivity();
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.resolve();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => socket.destroy(), CLOSE_TIMEOUT_MS).unref();
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      if (pending?.value === null) {
        this.pendingActivity = pending;
        socket.end();
      } else if (this.ready && (this.published !== null || pending !== null)) {
        socket.end(this.activityFrame(null, null));
      } else {
        socket.destroy();
      }
    });
  }

  private activityFrame(activity: DiscordActivity | null, value: string | null): Buffer {
    const nonce = randomUUID();
    this.pendingActivity = { nonce, value };
    return jsonFrame(Opcode.Frame, {
      cmd: "SET_ACTIVITY",
      nonce,
      args: { pid: process.pid, activity },
    });
  }

  private connect(firstIndex: number): void {
    if (this.closed) return;
    const index = this.paths.findIndex((path, index) => index >= firstIndex && isOwnedSocket(path));
    const path = this.paths[index];
    if (!path) {
      this.scheduleRetry();
      return;
    }
    const socket = createConnection({ path });
    this.socket = socket;
    socket.unref();

    let pending: Buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS).unref();
    socket.once("connect", () => {
      if (this.closed) return;
      socket.write(jsonFrame(Opcode.Handshake, { v: 1, client_id: this.applicationId }));
    });
    socket.on("data", (chunk: Buffer) => {
      if (this.closed && !this.pendingActivity) return;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= HEADER_SIZE && !socket.destroyed) {
        const opcode = pending.readUInt32LE(0);
        const size = pending.readUInt32LE(4);
        if (size > MAX_PAYLOAD_SIZE) {
          socket.destroy();
          return;
        }
        if (pending.length < HEADER_SIZE + size) return;
        const payload = pending.subarray(HEADER_SIZE, HEADER_SIZE + size);
        pending = pending.subarray(HEADER_SIZE + size);
        if (opcode === Opcode.Ping) {
          if (!this.closed) socket.write(frame(Opcode.Pong, payload));
        } else if (opcode === Opcode.Close) {
          socket.destroy();
        } else if (opcode === Opcode.Frame) {
          try {
            const reply = JSON.parse(payload.toString()) as {
              cmd?: unknown;
              evt?: unknown;
              nonce?: unknown;
            } | null;
            const request = this.pendingActivity;
            if (reply?.evt === "READY" && !this.ready && !this.closed) {
              clearTimeout(timeout);
              this.ready = true;
              this.refresh();
            } else if (reply?.cmd === "SET_ACTIVITY" && request && reply.nonce === request.nonce) {
              const operation = request.value === null ? "clear" : "publish";
              if (reply.evt === null || reply.evt === undefined) {
                this.clearPendingActivity();
                this.published = request.value;
                LOGGER.debug({ operation }, "Discord acknowledged a Rich Presence update");
                this.flush();
              } else if (reply.evt === "ERROR") {
                this.clearPendingActivity();
                LOGGER.debug({ operation }, "Discord rejected a Rich Presence update");
                this.scheduleRetry();
              }
            } else if (reply?.evt === "ERROR" && !this.ready) {
              socket.destroy();
            }
          } catch {
            socket.destroy();
          }
        }
      }
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timeout);
      const wasReady = this.ready;
      this.socket = null;
      this.ready = false;
      this.published = null;
      this.clearPendingActivity();
      if (this.closed || this.desiredActivity === null) return;
      if (!wasReady && index + 1 < this.paths.length) {
        this.connect(index + 1);
      } else {
        this.scheduleRetry();
      }
    });
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.flush();
    }, this.retryDelay).unref();
  }

  private clearPendingActivity(): void {
    this.pendingActivity = null;
    if (this.activityTimeout !== null) clearTimeout(this.activityTimeout);
    this.activityTimeout = null;
  }

  private cancelRetry(): void {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
  }
}

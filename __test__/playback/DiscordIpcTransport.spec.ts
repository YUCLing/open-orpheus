import { EventEmitter, getEventListeners } from "node:events";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { IPCTransport, RPCClient } from "@discordjs/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Candidate {
  kind?: "socket" | "symlink" | "file";
  uid?: number;
  connection?: "error" | "pending";
}

// 只模拟套接字边界，连接查找、分帧和取消仍执行实际依赖代码。
class ControlledSocket extends EventEmitter {
  destroyed = false;
  pending = true;
  ended = false;
  readonly writes: Buffer[] = [];
  private readonly incoming: Buffer[] = [];

  write(buffer: Buffer): boolean {
    this.writes.push(buffer);
    return true;
  }

  pause(): this {
    return this;
  }

  read(): Buffer | null {
    return this.incoming.shift() ?? null;
  }

  receive(buffer: Buffer): void {
    this.incoming.push(buffer);
    this.emit("readable");
  }

  end(): this {
    // 保持连接，模拟对端不响应关闭。
    this.ended = true;
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => {
      if (error) this.emit("error", error);
      this.emit("close", !!error);
    });
    return this;
  }
}

function rawFrame(payload: Buffer, length = payload.length): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(1, 0);
  header.writeUInt32LE(length, 4);
  return Buffer.concat([header, payload]);
}

describe.runIf(process.platform !== "win32")("Discord IPC 传输边界", () => {
  const runtime = "/rpc-test/runtime";
  const candidates = new Map<string, Candidate>();
  const sockets: ControlledSocket[] = [];
  const attempted: string[] = [];

  beforeEach(() => {
    candidates.clear();
    sockets.length = 0;
    attempted.length = 0;
    vi.stubEnv("XDG_RUNTIME_DIR", runtime);
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, undefined);
    vi.spyOn(fs, "lstat").mockImplementation(async (socketPath) => {
      const candidate = candidates.get(String(socketPath));
      if (!candidate) throw new Error("ENOENT");
      return {
        uid: candidate.uid ?? process.getuid!(),
        isSocket: () => !candidate.kind || candidate.kind === "socket",
      } as Stats;
    });
    vi.spyOn(net, "createConnection").mockImplementation(((socketPath: string) => {
      attempted.push(socketPath);
      const socket = new ControlledSocket();
      sockets.push(socket);
      const candidate = candidates.get(socketPath);
      if (candidate?.connection !== "pending") {
        queueMicrotask(() => {
          if (socket.destroyed) return;
          if (candidate?.connection === "error") {
            socket.emit("error", new Error("ECONNREFUSED"));
          } else {
            socket.pending = false;
            socket.emit("connect");
          }
        });
      }
      return socket as unknown as net.Socket;
    }) as typeof net.createConnection);
    // 外部 ESM 依赖持有 Node 内置模块的具名导出，需要同步测试替身。
    syncBuiltinESMExports();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.resolve();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
  });

  async function connect(): Promise<{ transport: IPCTransport; socket: ControlledSocket }> {
    const transport = new IPCTransport(new RPCClient());
    await transport.connect();
    return { transport, socket: sockets.at(-1)! };
  }

  it("拒绝其他用户、符号链接和普通文件，只连接本用户的实际 socket", async () => {
    candidates.set(`${runtime}/discord-ipc-0`, { uid: process.getuid!() + 1 });
    candidates.set(`${runtime}/discord-ipc-1`, { kind: "symlink" });
    candidates.set(`${runtime}/discord-ipc-2`, { kind: "file" });
    candidates.set(`${runtime}/discord-ipc-3`, {});

    await connect();

    expect(attempted).toEqual([`${runtime}/discord-ipc-3`]);
  });

  it("同 ID 候选连接失败后继续搜索其他环境目录", async () => {
    vi.stubEnv("TMPDIR", "/rpc-test/tmpdir");
    candidates.set(`${runtime}/discord-ipc-0`, { connection: "error" });
    candidates.set("/rpc-test/tmpdir/discord-ipc-0", {});

    await connect();

    expect(attempted).toEqual([`${runtime}/discord-ipc-0`, "/rpc-test/tmpdir/discord-ipc-0"]);
    expect(sockets[0].destroyed).toBe(true);
  });

  it.each(["TMP", "TEMP"])("拒绝相对目录，并搜索 %s 下的 snap socket", async (name) => {
    vi.stubEnv("XDG_RUNTIME_DIR", "relative/runtime");
    vi.stubEnv(name, "/rpc-test/fallback");
    candidates.set("relative/runtime/discord-ipc-0", {});
    candidates.set("/rpc-test/fallback/snap.discord/discord-ipc-4", {});

    await connect();

    expect(attempted).toEqual(["/rpc-test/fallback/snap.discord/discord-ipc-4"]);
    expect(
      vi.mocked(fs.lstat).mock.calls.every(([socketPath]) => String(socketPath).startsWith("/"))
    ).toBe(true);
  });

  it("处理完整首帧并保留下一帧未收齐的头部", async () => {
    candidates.set(`${runtime}/discord-ipc-0`, {});
    const { transport, socket } = await connect();
    const message = vi.fn();
    transport.on("message", message);
    const first = { nonce: "first" };
    const second = { nonce: "second" };
    const nextFrame = rawFrame(Buffer.from(JSON.stringify(second)));

    socket.receive(
      Buffer.concat([rawFrame(Buffer.from(JSON.stringify(first))), nextFrame.subarray(0, 5)])
    );
    expect(message.mock.calls).toEqual([[first]]);

    socket.receive(nextFrame.subarray(5));
    expect(message.mock.calls).toEqual([[first], [second]]);
    expect(socket.destroyed).toBe(false);
  });

  it("接受恰好 64 KiB 的载荷，超限长度只收到头部也立即断开", async () => {
    candidates.set(`${runtime}/discord-ipc-0`, {});
    const { transport, socket } = await connect();
    const message = vi.fn();
    transport.on("message", message);
    const overhead = Buffer.byteLength(JSON.stringify({ value: "" }));
    const payload = Buffer.from(JSON.stringify({ value: "x".repeat(64 * 1024 - overhead) }));

    socket.receive(rawFrame(payload));

    expect(payload.length).toBe(64 * 1024);
    expect(message).toHaveBeenCalledExactlyOnceWith(JSON.parse(payload.toString()));
    expect(socket.destroyed).toBe(false);

    socket.receive(rawFrame(Buffer.alloc(0), 64 * 1024 + 1));

    expect(socket.destroyed).toBe(true);
    expect(message).toHaveBeenCalledTimes(1);
  });

  it("等待未收齐的 JSON，完整帧仍为坏 JSON 时断开", async () => {
    candidates.set(`${runtime}/discord-ipc-0`, {});
    const { transport, socket } = await connect();
    const message = vi.fn();
    transport.on("message", message);

    socket.receive(rawFrame(Buffer.from("{"), 2));
    expect(socket.destroyed).toBe(false);
    socket.receive(Buffer.from("!"));

    expect(socket.destroyed).toBe(true);
    expect(message).not.toHaveBeenCalled();
  });

  it("底层连接尚未完成时取消会结束外层调用并销毁候选 socket", async () => {
    candidates.set(`${runtime}/discord-ipc-0`, { connection: "pending" });
    const client = new RPCClient();
    const controller = new AbortController();
    const reason = new Error("取消测试连接");
    const settled = expect(client.connect({ signal: controller.signal })).rejects.toBe(reason);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    controller.abort(reason);
    await settled;

    expect(sockets[0].destroyed).toBe(true);
    expect(sockets[0].listenerCount("connect")).toBe(0);
    expect(client.transport.listenerCount("close")).toBe(0);
    expect(client.listenerCount("READY")).toBe(0);
  });

  it("关闭超时后销毁不响应的 socket，并移除等待关闭的监听", async () => {
    candidates.set(`${runtime}/discord-ipc-0`, {});
    const { transport, socket } = await connect();
    const closing = transport.close({ signal: AbortSignal.timeout(10) });
    expect(socket.ended).toBe(true);

    await expect(closing).rejects.toMatchObject({ name: "TimeoutError" });

    expect(socket.destroyed).toBe(true);
    expect(transport.listenerCount("close")).toBe(0);
  });

  it("登录成功后触发原连接取消信号不会断开已建立的连接", async () => {
    candidates.set(`${runtime}/discord-ipc-0`, {});
    const client = new RPCClient();
    const controller = new AbortController();
    const connecting = client.connect({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets[0]?.listenerCount("readable")).toBe(1));
    const socket = sockets[0];
    socket.receive(
      rawFrame(Buffer.from(JSON.stringify({ cmd: "DISPATCH", evt: "READY", data: {} })))
    );
    await connecting;

    controller.abort();
    await Promise.resolve();

    expect(client.ready).toBe(true);
    expect(socket.destroyed).toBe(false);
  });

  it("关闭信号已取消时不发送关闭帧，并清除取消监听", async () => {
    candidates.set(`${runtime}/discord-ipc-0`, {});
    const { transport, socket } = await connect();
    const controller = new AbortController();
    const reason = new Error("关闭期限已过");
    controller.abort(reason);
    const previousWrites = socket.writes.length;

    await expect(transport.close({ signal: controller.signal })).rejects.toBe(reason);

    expect(socket.destroyed).toBe(true);
    expect(socket.writes).toHaveLength(previousWrites);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(transport.listenerCount("close")).toBe(0);
  });
});

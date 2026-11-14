import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DiscordPresence from "@main/playback/adapters/DiscordPresence";
import PlaybackController from "@main/playback/PlaybackController";
import { PlaybackChange } from "@main/playback/types";

const applicationId = "1569539057950658691";
const now = 1_760_000_000;
const temporaryRoot = tmpdir();

interface Message {
  client_id?: string;
  v?: number;
  cmd?: string;
  nonce?: string;
  args?: { pid: number; activity: unknown };
}

function sendFrame(opcode: number, payload: object): Buffer {
  const json = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

async function mockDiscord(subdir?: string, index = 0) {
  const dir = await mkdtemp(join(temporaryRoot, "oo-discord-"));
  const socketDir = subdir ? join(dir, subdir) : dir;
  if (subdir) await mkdir(socketDir, { recursive: true });
  const path = join(socketDir, `discord-ipc-${index}`);
  const sockets = new Set<Socket>();
  const messages: Array<{
    socket: Socket;
    opcode: number;
    payload: Message;
    receivedAt: number;
  }> = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const opcode = pending.readUInt32LE(0);
        const length = pending.readUInt32LE(4);
        if (pending.length < 8 + length) break;
        const payload = JSON.parse(pending.subarray(8, 8 + length).toString()) as Message;
        messages.push({ socket, opcode, payload, receivedAt: performance.now() });
        pending = pending.subarray(8 + length);
      }
    });
  });
  server.listen(path);
  await once(server, "listening");

  return {
    dir,
    path,
    messages,
    activities: () => messages.filter(({ payload }) => payload.cmd === "SET_ACTIVITY"),
    handshakes: () => messages.filter(({ opcode }) => opcode === 0),
    async close() {
      for (const socket of sockets) socket.destroy();
      const closed = once(server, "close");
      server.close();
      await closed;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function replyToActivity(
  { socket, payload }: { socket: Socket; payload: Message },
  evt: "ERROR" | null = null
): void {
  socket.write(
    sendFrame(1, {
      cmd: "SET_ACTIVITY",
      evt,
      nonce: payload.nonce,
      data: evt === "ERROR" ? { code: 4000, message: "rejected" } : {},
    })
  );
}

const waitFor = (assertion: () => void) => vi.waitFor(assertion, { interval: 5, timeout: 1000 });

describe.runIf(process.platform === "linux")("Discord Rich Presence over local IPC", () => {
  let discord: Awaited<ReturnType<typeof mockDiscord>>;
  let presence: DiscordPresence;
  let player: PlaybackController;

  beforeEach(async () => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    discord = await mockDiscord();
    vi.stubEnv("XDG_RUNTIME_DIR", discord.dir);
    vi.stubEnv("TMPDIR", discord.dir);
    player = new PlaybackController();
    presence = new DiscordPresence(player, { retryDelay: 15 });
  });

  afterEach(async () => {
    await presence.dispose();
    await discord.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("只在启用后共享歌名、歌手和时间，在暂停时清除，切歌后重新计时", async () => {
    const debug = vi.spyOn(LOGGER, "debug");
    const acknowledgement = "Discord acknowledged a Rich Presence update";
    player.setTrack({
      id: "/home/example/id",
      title: "第一首",
      artist: "歌手",
      album: "/local/album",
    });
    player.applyCover("file:///home/example/cover.png");
    player.applyDuration(180);
    player.applyPosition(15);
    player.applyPlaybackChange(PlaybackChange.Playing);
    await player.emit("statuschanged", player.snapshot.status);
    expect(discord.messages).toHaveLength(0);

    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    const [{ socket, payload }] = discord.handshakes();
    expect(payload).toEqual({ v: 1, client_id: applicationId });
    expect(discord.activities()).toHaveLength(0);

    const ready = sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} });
    const ping = sendFrame(3, { value: "ping" });
    socket.write(ready.subarray(0, 5));
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket.write(Buffer.concat([ready.subarray(5), ping]));
    await waitFor(() => expect(discord.messages).toHaveLength(3));
    expect(discord.messages.some(({ opcode, payload }) => opcode === 4 && "value" in payload)).toBe(
      true
    );
    expect(discord.activities()[0].payload.args).toEqual({
      pid: process.pid,
      activity: {
        type: 2,
        status_display_type: 2,
        instance: false,
        details: "第一首",
        assets: {
          large_image:
            "https://raw.githubusercontent.com/YUCLing/open-orpheus/v0.20.0/assets/icon_256.png",
          large_text: "Open Orpheus",
        },
        state: "歌手",
        timestamps: { start: now - 15, end: now + 165 },
      },
    });
    socket.write(
      Buffer.concat([
        sendFrame(1, { cmd: "SET_ACTIVITY", evt: null, nonce: "unrelated" }),
        sendFrame(1, {
          cmd: "SET_ACTIVITY",
          evt: null,
          nonce: discord.activities()[0].payload.nonce,
          data: { details: "private metadata" },
        }),
      ])
    );
    await waitFor(() => {
      expect(debug.mock.calls.filter(([, message]) => message === acknowledgement)).toEqual([
        [{ operation: "publish" }, acknowledgement],
      ]);
    });

    player.applyPosition(45, true);
    await waitFor(() => expect(discord.activities()).toHaveLength(2));
    expect(discord.activities()[1].payload.args?.activity).toMatchObject({
      timestamps: { start: now - 45, end: now + 135 },
    });
    replyToActivity(discord.activities()[1]);

    player.applyPlaybackChange(PlaybackChange.Paused);
    await waitFor(() => expect(discord.activities()).toHaveLength(3));
    expect(discord.activities()[2].payload.args?.activity).toBeUndefined();
    socket.write(
      sendFrame(1, { cmd: "SET_ACTIVITY", evt: null, nonce: discord.activities()[2].payload.nonce })
    );
    await waitFor(() =>
      expect(debug).toHaveBeenCalledWith({ operation: "clear" }, acknowledgement)
    );

    player.setTrack({ id: "2", title: "第二首", artist: "", album: "" });
    player.applyPlaybackChange(PlaybackChange.Playing);
    await waitFor(() => expect(discord.activities()).toHaveLength(4));
    expect(discord.activities()[3].payload.args?.activity).toMatchObject({
      type: 2,
      status_display_type: 2,
      details: "第二首",
      assets: { large_text: "Open Orpheus" },
    });
    expect(discord.activities()[3].payload.args?.activity).not.toHaveProperty("timestamps");
    replyToActivity(discord.activities()[3]);

    player.applyDuration(60);
    player.applyPosition(2);
    await waitFor(() => expect(discord.activities()).toHaveLength(5));
    expect(discord.activities()[4].payload.args?.activity).toMatchObject({
      timestamps: { start: now - 2, end: now + 58 },
    });
    replyToActivity(discord.activities()[4]);

    player.setTrack({ id: "3", title: "file:///home/example/music.flac", artist: "", album: "" });
    await waitFor(() => expect(discord.activities()).toHaveLength(6));
    expect(discord.activities()[5].payload.args?.activity).toBeUndefined();
  });

  it("按 UTF-8 字节截断标题，并省略本地路径元数据", async () => {
    player.setTrack({
      id: "/home/example/private/song.flac",
      title: `${"🎵".repeat(31)}音乐`,
      artist: "/home/example/private/artist",
      album: "file:///home/example/private/album",
    });
    player.applyPlaybackChange(PlaybackChange.Playing);
    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    discord.handshakes()[0].socket.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await waitFor(() => expect(discord.activities()).toHaveLength(1));

    // 再加入一个汉字会超过 128 字节，不能从字符中间截断。
    expect(discord.activities()[0].payload.args?.activity).toEqual({
      type: 2,
      status_display_type: 2,
      instance: false,
      details: `${"🎵".repeat(31)}音`,
      assets: {
        large_image:
          "https://raw.githubusercontent.com/YUCLing/open-orpheus/v0.20.0/assets/icon_256.png",
        large_text: "Open Orpheus",
      },
    });
    replyToActivity(discord.activities()[0]);
  });

  it("按播放倍速计算进度时间戳，修改倍速后重新计算", async () => {
    player.setTrack({ id: "1", title: "测试歌曲", artist: "", album: "" });
    player.applyDuration(180);
    player.applyPosition(20);
    player.applyRate(2);
    player.applyPlaybackChange(PlaybackChange.Playing);
    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    discord.handshakes()[0].socket.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await waitFor(() => expect(discord.activities()).toHaveLength(1));
    expect(discord.activities()[0].payload.args?.activity).toMatchObject({
      timestamps: { start: now - 10, end: now + 80 },
    });
    replyToActivity(discord.activities()[0]);

    player.applyRate(0.5);
    await waitFor(() => expect(discord.activities()).toHaveLength(2));
    expect(discord.activities()[1].payload.args?.activity).toMatchObject({
      timestamps: { start: now - 40, end: now + 320 },
    });
    replyToActivity(discord.activities()[1]);
  });

  it("卡顿时移除时间戳，恢复后根据最新进度和当前时间重算", async () => {
    player.setTrack({ id: "1", title: "测试歌曲", artist: "", album: "" });
    player.applyDuration(180);
    player.applyPosition(20);
    player.applyPlaybackChange(PlaybackChange.Playing);
    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    discord.handshakes()[0].socket.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await waitFor(() => expect(discord.activities()).toHaveLength(1));
    expect(discord.activities()[0].payload.args?.activity).toMatchObject({
      timestamps: { start: now - 20, end: now + 160 },
    });
    replyToActivity(discord.activities()[0]);

    player.applyPlaybackChange(PlaybackChange.Stalled);
    await waitFor(() => expect(discord.activities()).toHaveLength(2));
    expect(discord.activities()[1].payload.args?.activity).toMatchObject({ details: "测试歌曲" });
    expect(discord.activities()[1].payload.args?.activity).not.toHaveProperty("timestamps");
    replyToActivity(discord.activities()[1]);

    vi.mocked(Date.now).mockReturnValue((now + 10) * 1000);
    player.applyPosition(25);
    player.applyPlaybackChange(PlaybackChange.Playing);
    await waitFor(() => expect(discord.activities()).toHaveLength(3));
    expect(discord.activities()[2].payload.args?.activity).toMatchObject({
      timestamps: { start: now - 15, end: now + 165 },
    });
    replyToActivity(discord.activities()[2]);
  });

  it("发送被拒绝后只重试最新曲目，暂停清除被拒绝时重试清除", async () => {
    player.setTrack({ id: "1", title: "第一首", artist: "", album: "" });
    player.applyPlaybackChange(PlaybackChange.Playing);
    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    const { socket } = discord.handshakes()[0];
    socket.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await waitFor(() => expect(discord.activities()).toHaveLength(1));
    replyToActivity(discord.activities()[0]);

    player.setTrack({ id: "2", title: "第二首", artist: "", album: "" });
    await waitFor(() => expect(discord.activities()).toHaveLength(2));
    player.setTrack({ id: "3", title: "第三首", artist: "", album: "" });
    replyToActivity(discord.activities()[1], "ERROR");
    await waitFor(() => expect(discord.activities()).toHaveLength(3));
    expect(discord.activities()[2].payload.args?.activity).toMatchObject({ details: "第三首" });
    replyToActivity(discord.activities()[2]);

    player.applyPlaybackChange(PlaybackChange.Paused);
    await waitFor(() => expect(discord.activities()).toHaveLength(4));
    expect(discord.activities()[3].payload.args?.activity).toBeUndefined();
    replyToActivity(discord.activities()[3], "ERROR");
    await waitFor(() => expect(discord.activities()).toHaveLength(5));
    expect(discord.activities()[4].payload.args?.activity).toBeUndefined();
    replyToActivity(discord.activities()[4]);
  });

  it("发布回执超时后可以清除可能已显示的活动", async () => {
    await presence.dispose();
    presence = new DiscordPresence(player, { retryDelay: 15, requestTimeout: 50 });
    player.setTrack({ id: "1", title: "第一首", artist: "", album: "" });
    player.applyPlaybackChange(PlaybackChange.Playing);
    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    discord.handshakes()[0].socket.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await waitFor(() => expect(discord.activities()).toHaveLength(1));

    player.applyPlaybackChange(PlaybackChange.Paused);
    await waitFor(() => expect(discord.activities()).toHaveLength(2));
    expect(discord.activities()[1].payload.args?.activity).toBeUndefined();
    replyToActivity(discord.activities()[1]);
  });

  it("在 Discord 重启后发送当前曲目，关闭后重新开启会先清除旧活动", async () => {
    player.setTrack({ id: "1", title: "旧曲", artist: "", album: "" });
    player.applyPlaybackChange(PlaybackChange.Playing);
    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    const first = discord.handshakes()[0].socket;
    first.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await waitFor(() => expect(discord.activities()).toHaveLength(1));

    first.destroy();
    player.setTrack({ id: "2", title: "新曲", artist: "", album: "" });
    await waitFor(() => expect(discord.handshakes()).toHaveLength(2));
    const second = discord.handshakes()[1].socket;
    second.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await waitFor(() => {
      expect(
        discord.activities().find(({ socket }) => socket === second)?.payload.args?.activity
      ).toMatchObject({ details: "新曲" });
    });

    presence.configure(false);
    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(3));
    expect(
      discord
        .activities()
        .filter(({ socket }) => socket === second)
        .at(-1)?.payload.args?.activity
    ).toBeUndefined();
    const [{ socket: third, payload }] = discord.handshakes().slice(-1);
    expect(payload.client_id).toBe(applicationId);
    third.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await waitFor(() => {
      expect(
        discord.activities().find(({ socket }) => socket === third)?.payload.args?.activity
      ).toMatchObject({ details: "新曲" });
    });

    presence.configure(false);
    await presence.dispose();
    expect(discord.activities().at(-1)?.payload.args?.activity).toBeUndefined();
  });

  it("握手期间暂停并断开连接后保持空闲，再播放时可以恢复", async () => {
    player.setTrack({ id: "1", title: "测试歌曲", artist: "", album: "" });
    player.applyPlaybackChange(PlaybackChange.Playing);
    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    player.applyPlaybackChange(PlaybackChange.Paused);
    discord.handshakes()[0].socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(discord.handshakes()).toHaveLength(1);
    expect(discord.activities()).toHaveLength(0);

    player.applyPlaybackChange(PlaybackChange.Playing);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(2));
    discord.handshakes()[1].socket.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await waitFor(() => expect(discord.activities()).toHaveLength(1));
    replyToActivity(discord.activities()[0]);
  });

  it("握手未完成时关闭功能会取消连接", async () => {
    player.setTrack({ id: "1", title: "测试歌曲", artist: "", album: "" });
    player.applyPlaybackChange(PlaybackChange.Playing);
    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    await presence.dispose();
    await waitFor(() => expect(discord.handshakes()[0].socket.destroyed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(discord.handshakes()).toHaveLength(1);
    expect(discord.activities()).toHaveLength(0);
  });

  it.each(["timeout", "close", "disconnect"])(
    "握手 %s 后退避重试同一地址，并同步最新曲目",
    async (failure) => {
      player.setTrack({ id: "1", title: "旧曲", artist: "", album: "" });
      player.applyPlaybackChange(PlaybackChange.Playing);
      presence.configure(true);
      await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
      const first = discord.handshakes()[0].socket;
      if (failure === "close") first.write(sendFrame(2, { code: 4000, message: "rejected" }));
      if (failure === "disconnect") first.destroy();
      player.setTrack({ id: "2", title: "新曲", artist: "", album: "" });

      await vi.waitFor(() => expect(discord.handshakes()).toHaveLength(2), {
        interval: 5,
        timeout: 2000,
      });
      expect(first.destroyed).toBe(true);
      expect(discord.activities()).toHaveLength(0);
      const second = discord.handshakes()[1].socket;
      second.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
      await waitFor(() => expect(discord.activities()).toHaveLength(1));
      expect(discord.activities()[0].payload.args?.activity).toMatchObject({ details: "新曲" });
      replyToActivity(discord.activities()[0]);
    }
  );

  it("握手失败后等待退避，再重试连接", async () => {
    await presence.dispose();
    const retryDelay = 200;
    presence = new DiscordPresence(player, { retryDelay });
    player.setTrack({ id: "1", title: "测试歌曲", artist: "", album: "" });
    player.applyPlaybackChange(PlaybackChange.Playing);
    presence.configure(true);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    const disconnectedAt = performance.now();
    discord.handshakes()[0].socket.destroy();

    await waitFor(() => expect(discord.handshakes()).toHaveLength(2));
    expect(discord.handshakes()[1].receivedAt - disconnectedAt).toBeGreaterThanOrEqual(
      retryDelay - 10
    );
    discord.handshakes()[1].socket.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY", data: {} }));
    await waitFor(() => expect(discord.activities()).toHaveLength(1));
    replyToActivity(discord.activities()[0]);
  });

  it("跳过伪装为 Discord socket 的符号链接", async () => {
    const other = await mockDiscord();
    try {
      await presence.dispose();
      await discord.close();
      discord = await mockDiscord(undefined, 1);
      vi.stubEnv("XDG_RUNTIME_DIR", discord.dir);
      vi.stubEnv("TMPDIR", discord.dir);
      const symlinkPath = join(dirname(discord.path), "discord-ipc-0");
      await symlink(other.path, symlinkPath);
      presence = new DiscordPresence(player);
      player.setTrack({ id: "1", title: "测试歌曲", artist: "", album: "" });
      player.applyPlaybackChange(PlaybackChange.Playing);
      presence.configure(true);

      await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
      expect(other.handshakes()).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("跳过运行目录中的链接，直接连接 Flatpak Discord 的 socket", async () => {
    const flatpak = await mockDiscord(join("app", "com.discordapp.Discord"));
    try {
      await symlink(flatpak.path, join(flatpak.dir, "discord-ipc-0"));
      vi.stubEnv("XDG_RUNTIME_DIR", flatpak.dir);
      // 如果没找到 Flatpak 的 socket，连接也只会落到测试服务。
      vi.stubEnv("TMPDIR", discord.dir);
      await presence.dispose();
      presence = new DiscordPresence(player);
      player.setTrack({ id: "1", title: "测试歌曲", artist: "", album: "" });
      player.applyPlaybackChange(PlaybackChange.Playing);
      presence.configure(true);

      await waitFor(() => expect(flatpak.handshakes()).toHaveLength(1));
      expect(discord.handshakes()).toHaveLength(0);
    } finally {
      await presence.dispose();
      await flatpak.close();
    }
  });
});

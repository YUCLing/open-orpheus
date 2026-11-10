import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DiscordPresence from "../../src/main/playback/adapters/DiscordPresence";
import PlaybackController from "../../src/main/playback/PlaybackController";
import { PlaybackChange } from "../../src/main/playback/types";

const applicationId = "123456789012345678";
const now = 1_760_000_000;

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

async function mockDiscord() {
  const dir = await mkdtemp(join(tmpdir(), "oo-discord-"));
  const path = join(dir, "discord-ipc-0");
  const sockets = new Set<Socket>();
  const messages: Array<{ socket: Socket; opcode: number; payload: Message }> = [];
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
        messages.push({ socket, opcode, payload });
        pending = pending.subarray(8 + length);
      }
    });
  });
  server.listen(path);
  await once(server, "listening");

  return {
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

const waitFor = (assertion: () => void) => vi.waitFor(assertion, { interval: 5, timeout: 1000 });

describe.runIf(process.platform === "linux")("Discord Rich Presence over local IPC", () => {
  let discord: Awaited<ReturnType<typeof mockDiscord>>;
  let presence: DiscordPresence;
  let player: PlaybackController;

  beforeEach(async () => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    discord = await mockDiscord();
    player = new PlaybackController();
    presence = new DiscordPresence(player, { paths: [discord.path], retryDelay: 15 });
  });

  afterEach(async () => {
    await presence.dispose();
    await discord.close();
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
    presence.configure(true, "invalid");
    await player.emit("statuschanged", player.snapshot.status);
    expect(discord.messages).toHaveLength(0);

    presence.configure(true, applicationId);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    const [{ socket, payload }] = discord.handshakes();
    expect(payload).toEqual({ v: 1, client_id: applicationId });
    expect(discord.activities()).toHaveLength(0);

    const ready = sendFrame(1, { cmd: "DISPATCH", evt: "READY" });
    const ping = sendFrame(3, { value: "ping" });
    socket.write(ready.subarray(0, 5));
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

    player.applyPlaybackChange(PlaybackChange.Paused);
    await waitFor(() => expect(discord.activities()).toHaveLength(3));
    expect(discord.activities()[2].payload.args?.activity).toBeNull();
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

    player.applyDuration(60);
    player.applyPosition(2);
    await waitFor(() => expect(discord.activities()).toHaveLength(5));
    expect(discord.activities()[4].payload.args?.activity).toMatchObject({
      timestamps: { start: now - 2, end: now + 58 },
    });

    player.setTrack({ id: "3", title: "file:///home/example/music.flac", artist: "", album: "" });
    await waitFor(() => expect(discord.activities()).toHaveLength(6));
    expect(discord.activities()[5].payload.args?.activity).toBeNull();
  });

  it("在 Discord 重启后发送当前曲目，更换应用或关闭功能时清除活动", async () => {
    player.setTrack({ id: "1", title: "旧曲", artist: "", album: "" });
    player.applyPlaybackChange(PlaybackChange.Playing);
    presence.configure(true, applicationId);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
    const first = discord.handshakes()[0].socket;
    first.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY" }));
    await waitFor(() => expect(discord.activities()).toHaveLength(1));

    first.destroy();
    player.setTrack({ id: "2", title: "新曲", artist: "", album: "" });
    await waitFor(() => expect(discord.handshakes()).toHaveLength(2));
    const second = discord.handshakes()[1].socket;
    second.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY" }));
    await waitFor(() => {
      expect(
        discord.activities().find(({ socket }) => socket === second)?.payload.args?.activity
      ).toMatchObject({ details: "新曲" });
    });

    const replacementId = "234567890123456789";
    presence.configure(true, replacementId);
    await waitFor(() => expect(discord.handshakes()).toHaveLength(3));
    expect(
      discord
        .activities()
        .filter(({ socket }) => socket === second)
        .at(-1)?.payload.args?.activity
    ).toBeNull();
    const [{ socket: third, payload }] = discord.handshakes().slice(-1);
    expect(payload.client_id).toBe(replacementId);
    third.write(sendFrame(1, { cmd: "DISPATCH", evt: "READY" }));
    await waitFor(() => {
      expect(
        discord.activities().find(({ socket }) => socket === third)?.payload.args?.activity
      ).toMatchObject({ details: "新曲" });
    });

    presence.configure(false, replacementId);
    await presence.dispose();
    expect(discord.activities().at(-1)?.payload.args?.activity).toBeNull();
  });

  it("跳过伪装为 Discord socket 的符号链接", async () => {
    const other = await mockDiscord();
    try {
      const symlinkPath = join(dirname(discord.path), "discord-ipc-1");
      await symlink(other.path, symlinkPath);
      await presence.dispose();
      presence = new DiscordPresence(player, { paths: [symlinkPath, discord.path] });
      player.setTrack({ id: "1", title: "测试歌曲", artist: "", album: "" });
      player.applyPlaybackChange(PlaybackChange.Playing);
      presence.configure(true, applicationId);

      await waitFor(() => expect(discord.handshakes()).toHaveLength(1));
      expect(other.handshakes()).toHaveLength(0);
    } finally {
      await other.close();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<unknown>>(),
  configure: vi.fn(),
  dispose: vi.fn<() => Promise<void>>(),
  registerShutdownTask: vi.fn<(task: { run: () => Promise<void> }) => void>(),
}));

vi.mock("@main/settings", async () => {
  const { default: Emittery } = await import("emittery");
  return { kv: { get: mocks.get }, events: new Emittery() };
});
vi.mock("@main/lifecycle", () => ({ registerShutdownTask: mocks.registerShutdownTask }));
vi.mock("@main/playback/adapters/DiscordPresence", () => ({
  default: class {
    configure = mocks.configure;
    dispose = mocks.dispose;
  },
}));

import { events } from "@main/settings";
import PlaybackController from "@main/playback/PlaybackController";
import { initializeDiscordPresence } from "@main/playback/discordPresence";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("FLATPAK_ID", undefined);
  mocks.dispose.mockResolvedValue(undefined);
});

afterEach(() => {
  events.clearListeners();
  vi.unstubAllEnvs();
});

describe("Discord 听歌状态初始化", () => {
  it.each([undefined, null, "true", { enabled: true }])("设置 %j 不会启用分享", async (value) => {
    mocks.get.mockResolvedValue(value);
    await initializeDiscordPresence(new PlaybackController());
    expect(mocks.configure).toHaveBeenLastCalledWith(false);
  });

  it("Flatpak 环境仍读取开关并初始化功能", async () => {
    vi.stubEnv("FLATPAK_ID", "io.github.yucling.open-orpheus");
    mocks.get.mockResolvedValue(true);
    await initializeDiscordPresence(new PlaybackController());
    expect(mocks.get).toHaveBeenCalledWith("discordPresence.enabled");
    expect(mocks.configure).toHaveBeenCalledWith(true);
    expect(mocks.registerShutdownTask).toHaveBeenCalledOnce();
  });

  it("读取布尔开关并响应通用设置，在退出时取消订阅和清除活动", async () => {
    mocks.get.mockResolvedValue(true);
    await initializeDiscordPresence(new PlaybackController());
    expect(mocks.configure).toHaveBeenCalledWith(true);

    await events.emit("change", { key: "discordPresence.enabled", value: false });
    expect(mocks.configure).toHaveBeenLastCalledWith(false);
    await events.emit("change", { key: "discordPresence.enabled", value: true });
    expect(mocks.configure).toHaveBeenLastCalledWith(true);
    await events.emit("delete", { key: "discordPresence.enabled" });
    expect(mocks.configure).toHaveBeenLastCalledWith(false);

    mocks.configure.mockClear();
    await events.emit("change", { key: "proxy", value: { enabled: true } });
    expect(mocks.configure).not.toHaveBeenCalled();
    await mocks.registerShutdownTask.mock.calls[0][0].run();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    await events.emit("change", { key: "discordPresence.enabled", value: true });
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it("初始读取期间发生的开关更新不会被旧值覆盖", async () => {
    const stored = Promise.withResolvers<unknown>();
    mocks.get.mockReturnValue(stored.promise);
    const initializing = initializeDiscordPresence(new PlaybackController());
    await events.emit("change", { key: "discordPresence.enabled", value: true });
    stored.resolve(false);
    await initializing;
    expect(mocks.configure.mock.calls).toEqual([[true]]);
  });

  it("初始读取期间删除开关不会被旧值重新启用", async () => {
    const stored = Promise.withResolvers<unknown>();
    mocks.get.mockReturnValue(stored.promise);
    const initializing = initializeDiscordPresence(new PlaybackController());
    await events.emit("delete", { key: "discordPresence.enabled" });
    stored.resolve(true);
    await initializing;
    expect(mocks.configure.mock.calls).toEqual([[false]]);
  });
});

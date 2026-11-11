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
  it("首次安装和无效设置都保持关闭", async () => {
    mocks.get.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ enabled: "true" });
    await initializeDiscordPresence(new PlaybackController());
    expect(mocks.configure).toHaveBeenLastCalledWith(false);
    await initializeDiscordPresence(new PlaybackController());
    expect(mocks.configure).toHaveBeenLastCalledWith(false);
  });

  it("Flatpak 版忽略已启用的设置", async () => {
    vi.stubEnv("FLATPAK_ID", "io.github.yucling.open-orpheus");
    mocks.get.mockResolvedValue({ enabled: true });
    await initializeDiscordPresence(new PlaybackController());
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.registerShutdownTask).not.toHaveBeenCalled();
  });

  it("读取旧配置并响应通用设置，在退出时取消订阅和清除活动", async () => {
    mocks.get.mockResolvedValue({ enabled: true, applicationId: "1234567890123456789" });
    await initializeDiscordPresence(new PlaybackController());
    expect(mocks.configure).toHaveBeenCalledWith(true);

    await events.emit("change", { key: "discordPresence", value: { enabled: false } });
    expect(mocks.configure).toHaveBeenLastCalledWith(false);
    await events.emit("change", { key: "discordPresence", value: { enabled: true } });
    expect(mocks.configure).toHaveBeenLastCalledWith(true);
    await events.emit("delete", { key: "discordPresence" });
    expect(mocks.configure).toHaveBeenLastCalledWith(false);

    mocks.configure.mockClear();
    await events.emit("change", { key: "proxy", value: { enabled: true } });
    expect(mocks.configure).not.toHaveBeenCalled();
    await mocks.registerShutdownTask.mock.calls[0][0].run();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    await events.emit("change", { key: "discordPresence", value: { enabled: true } });
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it("初始读取期间发生的开关更新不会被旧值覆盖", async () => {
    const stored = Promise.withResolvers<unknown>();
    mocks.get.mockReturnValue(stored.promise);
    const initializing = initializeDiscordPresence(new PlaybackController());
    await events.emit("change", { key: "discordPresence", value: { enabled: true } });
    stored.resolve({ enabled: false });
    await initializing;
    expect(mocks.configure.mock.calls).toEqual([[true]]);
  });
});

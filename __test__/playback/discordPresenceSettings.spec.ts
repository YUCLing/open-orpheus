import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<unknown>>(),
  set: vi.fn<(key: string, value: unknown) => Promise<boolean>>(),
  configure: vi.fn(),
  dispose: vi.fn<() => Promise<void>>(),
  registerShutdownTask: vi.fn<(task: { run: () => Promise<void> }) => void>(),
}));

vi.mock("../../src/main/settings", () => ({ kv: { get: mocks.get, set: mocks.set } }));
vi.mock("../../src/main/lifecycle", () => ({ registerShutdownTask: mocks.registerShutdownTask }));
vi.mock("../../src/main/playback/adapters/DiscordPresence", () => ({
  default: class {
    configure = mocks.configure;
    dispose = mocks.dispose;
  },
}));

import PlaybackController from "../../src/main/playback/PlaybackController";
import {
  createDiscordPresence,
  getDiscordPresenceSettings,
  setDiscordPresenceSettings,
} from "../../src/main/playback/discordPresenceSettings";

const defaultApplicationId = "1569539057950658691";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("FLATPAK_ID", undefined);
  mocks.dispose.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Discord 听歌状态设置", () => {
  it("未设置或无效设置都保持关闭", async () => {
    mocks.get.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      enabled: "true",
    });
    const disabled = { enabled: false };
    await expect(getDiscordPresenceSettings()).resolves.toEqual(disabled);
    await expect(getDiscordPresenceSettings()).resolves.toEqual(disabled);
  });

  it.skipIf(process.platform !== "linux")("Flatpak 版忽略已启用的设置并拒绝启用", async () => {
    vi.stubEnv("FLATPAK_ID", "io.github.yucling.open-orpheus");
    const enabled = { enabled: true };
    mocks.get.mockResolvedValue(enabled);

    await expect(getDiscordPresenceSettings()).resolves.toEqual({ enabled: false });
    await expect(setDiscordPresenceSettings(enabled)).resolves.toBe(false);
    await createDiscordPresence(new PlaybackController());

    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.registerShutdownTask).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "linux")("旧设置保留分享状态并改用内置应用", async () => {
    mocks.get.mockResolvedValue({ enabled: true, applicationId: "1234567890123456789" });
    await expect(getDiscordPresenceSettings()).resolves.toEqual({ enabled: true });
    await createDiscordPresence(new PlaybackController());
    expect(mocks.configure).toHaveBeenCalledWith(true, defaultApplicationId);
    await mocks.registerShutdownTask.mock.calls[0][0].run();
  });

  it.skipIf(process.platform !== "linux")(
    "保存分享开关后使用内置应用，并在退出时释放",
    async () => {
      await createDiscordPresence(new PlaybackController());
      expect(mocks.configure).toHaveBeenCalledWith(false, defaultApplicationId);
      mocks.configure.mockClear();
      const enabled = { enabled: true };

      mocks.set.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await expect(setDiscordPresenceSettings(enabled)).resolves.toBe(false);
      expect(mocks.configure).not.toHaveBeenCalled();
      await expect(setDiscordPresenceSettings(enabled)).resolves.toBe(true);
      expect(mocks.set).toHaveBeenLastCalledWith("discordPresence", enabled);
      expect(mocks.configure).toHaveBeenCalledWith(true, defaultApplicationId);

      await mocks.registerShutdownTask.mock.calls[0][0].run();
      expect(mocks.dispose).toHaveBeenCalledOnce();
    }
  );
});

import { beforeEach, describe, expect, it, vi } from "vitest";

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

const applicationId = "1234567890123456789";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.dispose.mockResolvedValue(undefined);
});

describe("Discord 听歌状态设置", () => {
  it("未设置或无效设置都保持关闭", async () => {
    mocks.get.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      enabled: true,
      applicationId: "invalid",
    });
    const disabled = { enabled: false, applicationId: "" };
    await expect(getDiscordPresenceSettings()).resolves.toEqual(disabled);
    await expect(getDiscordPresenceSettings()).resolves.toEqual(disabled);
  });

  it.skipIf(process.platform !== "linux")("仅在设置写入成功后启用，并在退出时释放", async () => {
    await createDiscordPresence(new PlaybackController());
    expect(mocks.configure).toHaveBeenCalledWith(false, "");
    mocks.configure.mockClear();
    const enabled = { enabled: true, applicationId };

    mocks.set.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(setDiscordPresenceSettings(enabled)).resolves.toBe(false);
    expect(mocks.configure).not.toHaveBeenCalled();
    await expect(setDiscordPresenceSettings(enabled)).resolves.toBe(true);
    expect(mocks.configure).toHaveBeenCalledWith(true, applicationId);

    await mocks.registerShutdownTask.mock.calls[0][0].run();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});

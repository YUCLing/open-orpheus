import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configure: vi.fn(),
  dispose: vi.fn<() => Promise<void>>(),
  child: vi.fn(),
}));

vi.mock("./DiscordPresence", () => ({
  default: class {
    configure = mocks.configure;
    dispose = mocks.dispose;
  },
}));

import { activate, deactivate } from "./index";

const stop: () => Promise<void> = async () => {
  await deactivate?.();
};

function createRuntime(load: (key: string) => Promise<unknown>): Parameters<typeof activate>[0] {
  return { registry: { load } } as unknown as Parameters<typeof activate>[0];
}

function createLoad() {
  return vi.fn(async (key: string) => {
    if (key === "@main/mediaSession") {
      return { playbackController: { snapshot: {}, on: vi.fn() } };
    }
    if (key === "@main/logger") {
      return { default: { child: mocks.child } };
    }
    throw new Error(`unexpected registry key: ${key}`);
  });
}

beforeEach(async () => {
  await stop();
  vi.resetAllMocks();
  mocks.dispose.mockResolvedValue(undefined);
  mocks.child.mockReturnValue({ debug: vi.fn() });
});

describe("built-in Discord presence plugin", () => {
  it("activates the presence adapter with the host playback singleton", async () => {
    const load = createLoad();

    await activate(createRuntime(load));

    expect(load).toHaveBeenCalledWith("@main/mediaSession");
    expect(load).toHaveBeenCalledWith("@main/logger");
    expect(mocks.child).toHaveBeenCalledWith({ plugin: "discord-presence" });
    expect(mocks.configure).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("awaits disposal and is idempotent when deactivated", async () => {
    await activate(createRuntime(createLoad()));
    const stopping = Promise.withResolvers<void>();
    mocks.dispose.mockReturnValue(stopping.promise);
    let settled = false;

    const first = stop();
    void first?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    stopping.resolve();
    await first;
    expect(settled).toBe(true);
    expect(mocks.dispose).toHaveBeenCalledOnce();

    await stop();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("does nothing when deactivated before activation", async () => {
    await expect(stop()).resolves.toBeUndefined();
    expect(mocks.dispose).not.toHaveBeenCalled();
  });

  it("propagates host module failures without starting presence", async () => {
    const load = vi.fn(async (key: string) => {
      if (key === "@main/mediaSession") return { playbackController: {} };
      throw new Error("logger unavailable");
    });

    await expect(activate(createRuntime(load))).rejects.toThrow("logger unavailable");
    expect(mocks.configure).not.toHaveBeenCalled();
  });
});

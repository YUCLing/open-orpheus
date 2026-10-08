import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoggerStub } from "../helpers/globals";

installLoggerStub();

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
  disconnect: vi.fn(async () => {}),
  desktop: "wayland",
  shutdown: undefined as (() => Promise<void>) | undefined,
  shutdownRegistrations: 0,
}));
vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: "wayland" },
  getDesktopEnvironment: () => mocks.desktop,
}));
vi.mock("../../src/main/lifecycle", () => ({
  registerShutdownTask: (task: { run: () => Promise<void> }) => {
    mocks.shutdownRegistrations++;
    mocks.shutdown = task.run;
  },
}));
vi.mock("@open-orpheus/dbus", () => ({
  DbusClient: class {
    call = mocks.call;
    subscribe = mocks.subscribe;
    disconnect = mocks.disconnect;
  },
}));

describe.skipIf(process.platform !== "linux")("scoped tray activation", () => {
  const handlers = new Map<string, (err: Error | null, signal: { body: unknown[] }) => unknown>();
  let unsubscribe: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    mocks.desktop = "wayland";
    mocks.shutdownRegistrations = 0;
    mocks.call.mockReset().mockResolvedValue({ body: [true] });
    mocks.disconnect.mockReset().mockResolvedValue(undefined);
    unsubscribe = vi.fn();
    mocks.subscribe.mockReset().mockImplementation(async (match, handler) => {
      handlers.set(match.member, handler);
      return { unsubscribe };
    });
  });
  afterEach(async () => {
    await mocks.shutdown?.();
    mocks.shutdown = undefined;
  });
  async function fixture() {
    const { registerTrayActivation } = await import("../../src/main/menu/tray-activation");
    const show = vi.fn();
    const close = registerTrayActivation(show);
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalled());
    await Promise.allSettled(mocks.call.mock.results.map((result) => result.value));
    return { show, close };
  }

  it("subscribes before registration and uses the provider's scoped activation signal", async () => {
    const f = await fixture();
    expect(mocks.subscribe.mock.calls[0][0]).toMatchObject({
      sender: "org.openOrpheus.TrayPanel",
      member: "MusicPanelRequested",
    });
    expect(mocks.call.mock.calls[0][0].method).toBe("RegisterTray");
    handlers.get("MusicPanelRequested")!(null, { body: [] });
    expect(f.show).toHaveBeenCalledOnce();
  });

  it("keeps the existing behavior when the provider is old or absent", async () => {
    mocks.call.mockRejectedValue(new Error("UnknownMethod"));
    const f = await fixture();
    handlers.get("MusicPanelRequested")!(null, { body: [] });
    expect(f.show).not.toHaveBeenCalled();
  });

  it("restores the fallback on provider loss and registers again on provider restart", async () => {
    const f = await fixture();
    const owner = handlers.get("NameOwnerChanged")!;
    await owner(null, { body: ["org.openOrpheus.TrayPanel", ":1.old", ""] });
    handlers.get("MusicPanelRequested")!(null, { body: [] });
    expect(f.show).not.toHaveBeenCalled();
    await owner(null, { body: ["org.openOrpheus.TrayPanel", "", ":1.new"] });
    expect(mocks.call).toHaveBeenCalledTimes(2);
    handlers.get("MusicPanelRequested")!(null, { body: [] });
    expect(f.show).toHaveBeenCalledOnce();
  });

  it("disconnects exactly once on uninstall and shutdown and ignores later signals", async () => {
    const f = await fixture();
    f.close();
    await mocks.shutdown!();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    handlers.get("MusicPanelRequested")!(null, { body: [] });
    expect(f.show).not.toHaveBeenCalled();
  });

  it("cleans up a registration completing after uninstall", async () => {
    let complete!: (reply: { body: boolean[] }) => void;
    mocks.call.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const { registerTrayActivation } = await import("../../src/main/menu/tray-activation");
    const show = vi.fn();
    const close = registerTrayActivation(show);
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalled());
    close();
    complete({ body: [true] });
    await mocks.shutdown!();
    handlers.get("MusicPanelRequested")!(null, { body: [] });
    expect(show).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it("does not register on X11", async () => {
    mocks.desktop = "x11";
    const { registerTrayActivation } = await import("../../src/main/menu/tray-activation");
    registerTrayActivation(vi.fn())();
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("does not accumulate shutdown callbacks across tray reinstallations", async () => {
    const first = await fixture();
    first.close();
    await mocks.shutdown!();
    mocks.call.mockClear();
    const second = await fixture();
    expect(mocks.shutdownRegistrations).toBe(1);
    await mocks.shutdown!();
    expect(mocks.disconnect).toHaveBeenCalledTimes(2);
    handlers.get("MusicPanelRequested")!(null, { body: [] });
    expect(second.show).not.toHaveBeenCalled();
  });

  it("disconnects when the first subscription fails", async () => {
    mocks.subscribe.mockRejectedValueOnce(new Error("First subscription failed"));
    const { registerTrayActivation } = await import("../../src/main/menu/tray-activation");
    registerTrayActivation(vi.fn());
    await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
    await mocks.shutdown!();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it("cleans up partial initialization without waiting for tray uninstall", async () => {
    mocks.subscribe
      .mockResolvedValueOnce({ unsubscribe })
      .mockRejectedValueOnce(new Error("Owner subscription failed"));
    const { registerTrayActivation } = await import("../../src/main/menu/tray-activation");
    registerTrayActivation(vi.fn());
    await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.call).not.toHaveBeenCalled();
    await mocks.shutdown!();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it("removes a subscription that finishes after uninstall", async () => {
    let complete!: (subscription: { unsubscribe: typeof unsubscribe }) => void;
    mocks.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const { registerTrayActivation } = await import("../../src/main/menu/tray-activation");
    const close = registerTrayActivation(vi.fn());
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
    close();
    complete({ unsubscribe });
    await mocks.shutdown!();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("retires cleanup ownership even when disconnect rejects", async () => {
    await fixture();
    mocks.disconnect.mockRejectedValueOnce(new Error("Disconnect failed"));
    await expect(mocks.shutdown!()).rejects.toThrow("Failed to close tray activations");
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    await mocks.shutdown!();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
});

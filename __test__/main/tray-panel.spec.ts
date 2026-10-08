import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoggerStub } from "../helpers/globals";

installLoggerStub();

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  dismiss: undefined as ((err: Error | null, signal: { body: unknown[] }) => undefined) | undefined,
  disconnect: vi.fn(async () => {}),
  desktop: "wayland",
  shutdown: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: "wayland" },
  getDesktopEnvironment: () => mocks.desktop,
}));
vi.mock("../../src/main/lifecycle", () => ({
  registerShutdownTask: (task: { run: () => Promise<void> }) => {
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

describe.skipIf(process.platform !== "linux")("optional tray-panel adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.desktop = "wayland";
    mocks.call.mockReset().mockResolvedValue({ body: [true] });
    mocks.unsubscribe.mockReset();
    mocks.subscribe.mockReset().mockImplementation(async (_match, callback) => {
      mocks.dismiss = callback;
      return { unsubscribe: mocks.unsubscribe };
    });
    mocks.disconnect.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("does not use the bridge on X11", async () => {
    mocks.desktop = "x11";
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    expect(await bridge.takeTrayPanel(1)).toBeUndefined();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("consumes once, only for the requesting renderer", async () => {
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(42);
    expect(await bridge.takeTrayPanel(7)).toBeUndefined();
    const panel = await bridge.takeTrayPanel(42);
    expect(panel?.title).toMatch(/^Open Orpheus Tray Panel /);
    expect(await bridge.takeTrayPanel(42)).toBeUndefined();
    await panel!.place();
    expect(mocks.call.mock.calls.at(-1)?.[0]).toMatchObject({
      method: "PlacePanel",
      body: [panel!.title],
    });
    panel!.cancel();
    await Promise.resolve();
    expect(mocks.call.mock.calls.at(-1)?.[0].method).toBe("CancelPanel");
  });

  it("does not consume a stale tray request", async () => {
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    vi.advanceTimersByTime(2001);
    expect(await bridge.takeTrayPanel(1)).toBeUndefined();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("falls back when the extension is absent", async () => {
    mocks.call.mockRejectedValue(new Error("UnknownObject"));
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    expect(await bridge.takeTrayPanel(1)).toBeUndefined();
  });

  it("retries initialization after a temporary subscription failure", async () => {
    mocks.subscribe.mockRejectedValueOnce(new Error("Temporary bus failure"));
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    expect(await bridge.takeTrayPanel(1)).toBeUndefined();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.call).not.toHaveBeenCalled();
    bridge.noteTrayMenuRequest(1);
    expect(await bridge.takeTrayPanel(1)).toBeDefined();
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ method: "PreparePanel" }));
  });

  it.each(["ready", "rejected", "timeout"])(
    "discards a superseded preparation on %s instead of requesting overlay",
    async (result) => {
      let ready!: (reply: { body: boolean[] }) => void;
      let fail!: (error: Error) => void;
      mocks.call.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            ready = resolve;
            fail = reject;
          })
      );
      const bridge = await import("../../src/main/menu/tray-panel");
      bridge.noteTrayMenuRequest(1);
      const old = bridge.takeTrayPanel(1);
      await vi.advanceTimersByTimeAsync(0);
      bridge.noteTrayMenuRequest(1);
      const current = await bridge.takeTrayPanel(1);
      expect(current).toBeDefined();
      if (result === "ready") ready({ body: [true] });
      else if (result === "rejected") fail(new Error("Old preparation failed"));
      else await vi.advanceTimersByTimeAsync(600);
      expect(await old).toBeNull();
      if (result === "timeout") ready({ body: [true] });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ method: "CancelPanel" }));
      await current!.place();
    }
  );

  it("cancels a reservation that completes after the deadline", async () => {
    let ready!: (reply: { body: boolean[] }) => void;
    mocks.call.mockImplementation(({ method }) =>
      method === "PreparePanel"
        ? new Promise((resolve) => {
            ready = resolve;
          })
        : Promise.resolve({ body: [] })
    );
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    const pending = bridge.takeTrayPanel(1);
    await vi.advanceTimersByTimeAsync(601);
    expect(await pending).toBeUndefined();
    ready({ body: [true] });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.call.mock.calls.at(-1)?.[0].method).toBe("CancelPanel");
  });

  it("disconnects the lazy connection on shutdown", async () => {
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    await bridge.takeTrayPanel(1);
    await mocks.shutdown!();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    bridge.noteTrayMenuRequest(1);
    expect(await bridge.takeTrayPanel(1)).toBeUndefined();
  });

  it("accepts a provider on another Wayland desktop", async () => {
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    expect(await bridge.takeTrayPanel(1)).toBeDefined();
    expect(mocks.call.mock.calls[0][0].destination).toBe("org.openOrpheus.TrayPanel");
  });

  it("retires the connection reference even when shutdown disconnect fails", async () => {
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    await bridge.takeTrayPanel(1);
    mocks.disconnect.mockRejectedValueOnce(new Error("Disconnect failed"));
    await expect(mocks.shutdown!()).rejects.toThrow("Disconnect failed");
    await mocks.shutdown!();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it("cleans up subscription initialization that completes after shutdown", async () => {
    let complete!: (subscription: { unsubscribe: typeof mocks.unsubscribe }) => void;
    mocks.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    const preparing = bridge.takeTrayPanel(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    const closing = mocks.shutdown!();
    complete({ unsubscribe: mocks.unsubscribe });
    await closing;
    expect(await preparing).toBeNull();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("bounds placement and cancels a stalled reservation", async () => {
    mocks.call.mockImplementation(({ method }) =>
      method === "PlacePanel" ? new Promise(() => {}) : Promise.resolve({ body: [true] })
    );
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    const panel = (await bridge.takeTrayPanel(1))!;
    const result = expect(panel.place()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1500);
    await result;
    expect(mocks.call.mock.calls.at(-1)?.[0].method).toBe("CancelPanel");
  });

  it("dismisses only the matching live panel and stops listening after cancellation", async () => {
    const bridge = await import("../../src/main/menu/tray-panel");
    bridge.noteTrayMenuRequest(1);
    const panel = (await bridge.takeTrayPanel(1))!;
    const close = vi.fn();
    panel.onDismiss(close);
    mocks.dismiss!(null, { body: ["old-panel"] });
    mocks.dismiss!(new Error("disconnected"), { body: [panel.title] });
    expect(close).not.toHaveBeenCalled();
    mocks.dismiss!(null, { body: [panel.title] });
    expect(close).toHaveBeenCalledOnce();
    panel.cancel();
    mocks.dismiss!(null, { body: [panel.title] });
    expect(close).toHaveBeenCalledOnce();
    await mocks.shutdown!();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });
});

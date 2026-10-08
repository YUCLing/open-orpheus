import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoggerStub } from "../helpers/globals";
import * as protocol from "../../src/main/windows/stacking-protocol";

installLoggerStub();
const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; body?: unknown[] }>,
  desktop: 0,
  busUnavailable: false,
  providerPresent: false,
  hangOwner: false,
  aboveStatus: "applied",
  hangAbove: false,
  settleAbove: null as null | (() => void),
  releaseFailed: false,
  ownerChanged: null as null | ((err: unknown, signal: { body: unknown[] }) => Promise<unknown>),
  tasks: [] as Array<{ run: (signal?: AbortSignal) => Promise<void> }>,
}));
vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: 0 },
  getDesktopEnvironment: () => mocks.desktop,
}));
vi.mock("../../src/main/lifecycle", () => ({
  registerShutdownTask: (task: { run: (signal?: AbortSignal) => Promise<void> }) =>
    mocks.tasks.push(task),
}));
vi.mock("@open-orpheus/dbus", () => ({
  DbusClient: class {
    async call(options: { method: string; body?: unknown[] }) {
      mocks.calls.push(options);
      if (mocks.busUnavailable) throw new Error("org.freedesktop.DBus.Error.ServiceUnknown");
      if (options.method === "NameHasOwner") {
        if (mocks.hangOwner) return new Promise<never>(() => {});
        return { body: [mocks.providerPresent] };
      }
      if (options.method === "SetAbove") {
        if (mocks.hangAbove)
          return new Promise<{ body: string[] }>((resolve) => {
            mocks.settleAbove = () => resolve({ body: ["applied"] });
          });
        return { body: [mocks.aboveStatus] };
      }
      if (options.method === "Release") {
        if (mocks.releaseFailed) throw new Error("Release rejected");
        return { body: [] };
      }
      throw new Error("org.freedesktop.DBus.Error.UnknownMethod");
    }
    async subscribe(_options: unknown, handler: typeof mocks.ownerChanged) {
      mocks.ownerChanged = handler;
      return { unsubscribe: () => mocks.calls.push({ method: "unsubscribe" }) };
    }
    async disconnect() {
      mocks.calls.push({ method: "disconnect" });
    }
  },
}));
describe("desktop stacking adapter", () => {
  const target = { id: "1", title: "Open Orpheus Lyrics (123:1)", pid: 123 };
  async function loadAdapter() {
    const module = await import("../../src/main/windows/stacking-adapter");
    await module.initializeWindowStackingAdapter();
    return module;
  }
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("XDG_CURRENT_DESKTOP", "KDE");
    mocks.calls = [];
    mocks.tasks = [];
    mocks.desktop = 0;
    mocks.busUnavailable = false;
    mocks.providerPresent = false;
    mocks.hangOwner = false;
    mocks.aboveStatus = "applied";
    mocks.hangAbove = false;
    mocks.settleAbove = null;
    mocks.releaseFailed = false;
    mocks.ownerChanged = null;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it("preserves the public contract for independently installed adapters", () => {
    expect(protocol.STACKING_DBUS).toEqual({
      destination: "org.openorpheus.WindowStacking",
      path: "/org/openorpheus/WindowStacking",
      interfaceName: "org.openorpheus.WindowStacking",
    });
  });
  it("does not load a KWin script when no external provider is running", async () => {
    const module = await loadAdapter();
    expect(module.getWindowStackingAdapter()).toBeNull();
    expect(mocks.calls.map((call) => call.method)).toEqual(["NameHasOwner", "disconnect"]);
  });
  it("discards a retired external adapter immediately", async () => {
    mocks.providerPresent = true;
    const module = await loadAdapter();
    const adapter = module.getWindowStackingAdapter()!;
    await adapter.setAbove(target, true);
    mocks.calls = [];
    expect(module.disableWindowStackingAdapter(adapter)).toBe(true);
    expect(module.getWindowStackingAdapter()).toBeNull();
    await vi.waitFor(() =>
      expect(mocks.calls.some((call) => call.method === "disconnect")).toBe(true)
    );
    expect(await adapter.setAbove(target, true)).toBe("failed");
    await mocks.tasks[0].run();
  });
  it("does not probe the session bus in a non-Wayland session", async () => {
    mocks.desktop = 1;
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    expect(getWindowStackingAdapter()).toBeNull();
    expect(mocks.calls).toHaveLength(0);
  });

  it("uses the same target identity for the GNOME extension and releases it", async () => {
    vi.stubEnv("XDG_CURRENT_DESKTOP", "GNOME");
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    const adapter = getWindowStackingAdapter()!;
    expect(await adapter.setAbove(target, true)).toBe("applied");
    expect(mocks.calls.find((call) => call.method === "SetAbove")).toMatchObject({
      destination: "org.openorpheus.WindowStacking",
      method: "SetAbove",
      signature: "ssub",
      body: [target.id, target.title, target.pid, true],
    });
    await adapter.release(target.id);
    expect(mocks.calls.at(-1)).toMatchObject({ method: "Release", body: [target.id] });
    await mocks.tasks[0].run();
    expect(mocks.calls.at(-1)?.method).toBe("disconnect");
  });

  it("does not select an absent extension", async () => {
    vi.stubEnv("XDG_CURRENT_DESKTOP", "GNOME");
    mocks.busUnavailable = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    expect(getWindowStackingAdapter()).toBeNull();
    expect(mocks.tasks).toHaveLength(0);
    expect(mocks.calls.at(-1)?.method).toBe("disconnect");
  });

  it("discovers an external provider without a desktop whitelist and replays live requests", async () => {
    vi.stubEnv("XDG_CURRENT_DESKTOP", "COSMIC");
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    const adapter = getWindowStackingAdapter()!;
    await adapter.setAbove(target, true);
    mocks.calls = [];
    await mocks.ownerChanged!(null, { body: ["org.openorpheus.WindowStacking", "", ":1.99"] });
    expect(mocks.calls.map((call) => call.method)).toEqual(["SetAbove"]);
    await adapter.release(target.id);
    mocks.calls = [];
    await mocks.ownerChanged!(null, { body: ["org.openorpheus.WindowStacking", "", ":1.100"] });
    expect(mocks.calls.some((call) => call.method === "SetAbove")).toBe(false);
    await mocks.tasks[0].run();
    expect(mocks.calls.some((call) => call.method === "unsubscribe")).toBe(true);
  });

  it("uses only the external adapter even when KWin is present", async () => {
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    expect(await getWindowStackingAdapter()!.setAbove(target, true)).toBe("applied");
    expect(mocks.calls.some((call) => call.method === "loadScript")).toBe(false);
  });

  it("uses an adapter that implements only SetAbove and Release without a compatibility handshake", async () => {
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    const adapter = getWindowStackingAdapter()!;
    expect(await adapter.setAbove(target, true)).toBe("applied");
    await adapter.release(target.id);
    expect(mocks.calls.map((call) => call.method)).toEqual(["NameHasOwner", "SetAbove", "Release"]);
    await mocks.tasks[0].run();
  });

  it("reports failure when a provider returns an invalid placement acknowledgement", async () => {
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    mocks.aboveStatus = "unexpected";
    expect(await getWindowStackingAdapter()!.setAbove(target, true)).toBe("failed");
    await mocks.tasks[0].run();
  });

  it("does not claim success when a selected provider disappears", async () => {
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    mocks.busUnavailable = true;
    expect(await getWindowStackingAdapter()!.setAbove(target, true)).toBe("unsupported");
    await mocks.tasks[0].run();
  });

  it("bounds discovery of a stalled provider and leaves Electron fallback available", async () => {
    vi.useFakeTimers();
    mocks.providerPresent = true;
    mocks.hangOwner = true;
    const module = await import("../../src/main/windows/stacking-adapter");
    const first = module.initializeWindowStackingAdapter();
    expect(module.initializeWindowStackingAdapter()).toBe(first);
    await vi.advanceTimersByTimeAsync(500);
    await first;
    expect(module.getWindowStackingAdapter()).toBeNull();
    expect(mocks.calls.filter((call) => call.method === "NameHasOwner")).toHaveLength(1);
    expect(mocks.calls.some((call) => call.method === "SetAbove")).toBe(false);
    expect(mocks.calls.some((call) => call.method === "disconnect")).toBe(true);
  });

  it("does not replay a closed window when its release request fails", async () => {
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    const adapter = getWindowStackingAdapter()!;
    await adapter.setAbove(target, true);
    mocks.releaseFailed = true;
    await expect(adapter.release(target.id)).rejects.toThrow("Release rejected");
    mocks.calls = [];
    await mocks.ownerChanged!(null, { body: ["org.openorpheus.WindowStacking", "", ":1.99"] });
    expect(mocks.calls.some((call) => call.method === "SetAbove")).toBe(false);
    await mocks.tasks[0].run();
  });

  it("retires a closed window before a queued reconnect can replay it", async () => {
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    const adapter = getWindowStackingAdapter()!;
    mocks.hangAbove = true;
    const applying = adapter.setAbove(target, true);
    await vi.waitFor(() => expect(mocks.settleAbove).not.toBeNull());
    const replaying = mocks.ownerChanged!(null, {
      body: ["org.openorpheus.WindowStacking", "", ":1.new"],
    });
    const releasing = adapter.release(target.id);
    mocks.hangAbove = false;
    mocks.settleAbove!();
    await Promise.all([applying, replaying, releasing]);
    expect(mocks.calls.filter((call) => call.method === "SetAbove")).toHaveLength(1);
    expect(mocks.calls.at(-1)?.method).toBe("Release");
    await mocks.tasks[0].run();
  });

  it("does not recreate a released target from a queued initial request", async () => {
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    const adapter = getWindowStackingAdapter()!;
    mocks.hangAbove = true;
    const applying = adapter.setAbove(target, true);
    await vi.waitFor(() => expect(mocks.settleAbove).not.toBeNull());
    const queued = adapter.setAbove({ ...target, id: "2" }, true);
    const releasing = adapter.release("2");
    mocks.hangAbove = false;
    mocks.settleAbove!();
    await applying;
    expect(await queued).toBe("failed");
    await releasing;
    const replaying = mocks.ownerChanged!(null, {
      body: ["org.openorpheus.WindowStacking", "", ":1.new"],
    });
    await replaying;
    expect(
      mocks.calls.filter((call) => call.method === "SetAbove" && call.body?.[0] === "2")
    ).toHaveLength(0);
    await mocks.tasks[0].run();
  });

  it("attempts every external release even when a provider rejects cleanup", async () => {
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    const adapter = getWindowStackingAdapter()!;
    await adapter.setAbove(target, true);
    await adapter.setAbove({ ...target, id: "2" }, true);
    mocks.releaseFailed = true;
    mocks.calls = [];
    await expect(mocks.tasks[0].run()).rejects.toThrow("Failed to release stacking targets");
    expect(mocks.calls.filter((call) => call.method === "Release")).toHaveLength(2);
    expect(mocks.calls.at(-1)?.method).toBe("disconnect");
  });

  it("drops the client connection on shutdown abort without waiting for the request queue", async () => {
    mocks.providerPresent = true;
    const { getWindowStackingAdapter } = await loadAdapter();
    mocks.hangAbove = true;
    const pending = getWindowStackingAdapter()!.setAbove(target, true);
    await vi.waitFor(() => expect(mocks.settleAbove).not.toBeNull());
    const controller = new AbortController();
    const closing = mocks.tasks[0].run(controller.signal);
    controller.abort();
    await Promise.resolve();
    expect(mocks.calls.some((call) => call.method === "disconnect")).toBe(true);
    mocks.settleAbove!();
    await pending;
    await closing;
  });
});

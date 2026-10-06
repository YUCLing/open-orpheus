import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";

import { installLoggerStub } from "../helpers/globals";

installLoggerStub();

type ScheduledShutdown = [string | "", number];

const hoisted = vi.hoisted(() => ({
  /** Every method name passed to the fake bus, in call order. */
  calls: [] as string[],
  /** What the logind `ScheduledShutdown` property reports. */
  scheduled: ["", 0] as [string | "", number],
  /** Refuse `ScheduleShutdown` like an unprivileged caller would be refused. */
  failSchedule: false,
  /** Fail to connect to the system bus at all. */
  failConstruct: false,
  /** Hold a `ScheduleShutdown` call open until the test releases it. */
  gateSchedule: false,
  /** Resolver for a `ScheduleShutdown` call the test wants to hold open. */
  release: null as null | (() => void),
  /** Shutdown tasks registered by the module under test. */
  tasks: [] as Array<{ name: string; run: () => void | Promise<void> }>,
  /** Shutdown finalizers registered by the module under test. */
  finalizers: [] as Array<{ name: string; run: () => void | Promise<void> }>,
  /** Windows system-module calls, in order. */
  win32Calls: [] as string[],
  /** What `canShutdown` reports. */
  canShutdown: true,
  /** Make `canShutdown` throw, like an unreadable process token would. */
  canShutdownError: false,
  /** Make `shutdownNow` throw, like a refused power-off would. */
  shutdownNowError: false,
  /** Refuse the dynamic import of the Windows module entirely. */
  failSystemModule: false,
  /** Arguments the last `shutdownNow` received. */
  shutdownNowArgs: null as null | [string, boolean],
}));

vi.mock("@open-orpheus/dbus", () => {
  class DbusClient {
    constructor(bus: string) {
      if (hoisted.failConstruct) throw new Error("no system bus");
      if (bus !== "system") throw new Error(`unexpected bus ${bus}`);
    }

    async call(options: { method: string; body?: unknown[] }) {
      hoisted.calls.push(options.method);
      switch (options.method) {
        case "CanPowerOff":
          return { signature: "s", body: ["yes"] };
        case "ScheduleShutdown": {
          if (hoisted.failSchedule) throw new Error("access denied");
          if (hoisted.gateSchedule) {
            await new Promise<void>((resolve) => {
              hoisted.release = resolve;
            });
          }
          hoisted.scheduled = ["poweroff", options.body?.[1] as number];
          return { signature: "", body: [] };
        }
        case "CancelScheduledShutdown":
          hoisted.scheduled = ["", 0];
          return { signature: "", body: [] };
        default:
          throw new Error(`unexpected method ${options.method}`);
      }
    }

    async getProperty() {
      return {
        signature: "(st)",
        value: [...hoisted.scheduled] as ScheduledShutdown,
      };
    }
  }

  return { DbusClient };
});

// `shutdown.ts` only needs the registration hooks; importing the real module
// would pull Electron in.
vi.mock("@main/services/lifecycle", () => ({
  registerShutdownTask: (task: { name: string; run: () => void | Promise<void> }) =>
    hoisted.tasks.push(task),
  registerShutdownFinalizer: (finalizer: { name: string; run: () => void | Promise<void> }) =>
    hoisted.finalizers.push(finalizer),
}));

// The Windows module's *shape* has to be able to differ per test (see
// `failSystemModule`), and a logged `vi.mock` factory result is cached for the
// lifetime of the file, so it is registered fresh in `beforeEach` instead.
function makeSystemModuleMock() {
  return {
    canShutdown: () => {
      hoisted.win32Calls.push("canShutdown");
      if (hoisted.canShutdownError) throw new Error("token denied");
      return hoisted.canShutdown;
    },
    shutdownNow: (message: string, forceAppsClosed: boolean) => {
      hoisted.win32Calls.push("shutdownNow");
      hoisted.shutdownNowArgs = [message, forceAppsClosed];
      if (hoisted.shutdownNowError) throw new Error("shutdown refused");
    },
  };
}

async function loadModule() {
  return import("@main/bootstrap/shutdown");
}

/** Wait until `predicate` holds, failing if it never does. */
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("timed out waiting for the fake bus");
}

/** Run the module under test as if this process were on Windows. */
function useWindows() {
  vi.mocked(os.platform).mockReturnValue("win32");
}

/** A schedule far enough out that no test can reach it by accident. */
const HOUR = 60 * 60 * 1000;

function task() {
  const found = hoisted.tasks.find((t) => t.name === "scheduled-shutdown");
  if (!found) throw new Error("the shutdown task was not registered");
  return found;
}

/**
 * The power-off is registered as a finalizer, not a task: it has to survive the
 * cleanup tasks using up the shutdown deadline.
 */
function finalizer() {
  const found = hoisted.finalizers.find((f) => f.name === "scheduled-shutdown-poweroff");
  if (!found) throw new Error("the power-off finalizer was not registered");
  return found;
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(os, "platform").mockReturnValue("linux");
  hoisted.calls = [];
  hoisted.scheduled = ["", 0];
  hoisted.failSchedule = false;
  hoisted.failConstruct = false;
  hoisted.gateSchedule = false;
  hoisted.release = null;
  hoisted.tasks = [];
  hoisted.finalizers = [];
  hoisted.win32Calls = [];
  hoisted.canShutdown = true;
  hoisted.canShutdownError = false;
  hoisted.shutdownNowError = false;
  hoisted.failSystemModule = false;
  hoisted.shutdownNowArgs = null;
  vi.doMock("@open-orpheus/system-win32", () => {
    if (hoisted.failSystemModule) throw new Error("no native binding");
    return makeSystemModuleMock();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setScheduledShutdown", () => {
  it("reports failure instead of rejecting when the system bus is unreachable", async () => {
    hoisted.failConstruct = true;
    const { ScheduleShutdownStatus, setScheduledShutdown } = await loadModule();

    await expect(setScheduledShutdown(new Date())).resolves.toBe(ScheduleShutdownStatus.Failed);
  });

  it("reports failure when the system refuses the request", async () => {
    hoisted.failSchedule = true;
    const { ScheduleShutdownStatus, setScheduledShutdown } = await loadModule();

    await expect(setScheduledShutdown(new Date(Date.now() + 60_000))).resolves.toBe(
      ScheduleShutdownStatus.Failed
    );
  });

  it("leaves an external schedule alone", async () => {
    hoisted.scheduled = ["poweroff", 1_234_567];
    const { ScheduleShutdownStatus, setScheduledShutdown, hasManagedScheduledShutdown } =
      await loadModule();

    await expect(setScheduledShutdown(new Date(Date.now() + 60_000))).resolves.toBe(
      ScheduleShutdownStatus.ManagedExternally
    );
    expect(hoisted.calls).toEqual(["CanPowerOff"]);
    expect(hasManagedScheduledShutdown()).toBe(false);
  });

  it("treats a cancel with no managed schedule as already satisfied", async () => {
    const { ScheduleShutdownStatus, setScheduledShutdown } = await loadModule();

    await expect(setScheduledShutdown()).resolves.toBe(ScheduleShutdownStatus.AlreadySet);
    expect(hoisted.calls).toEqual(["CanPowerOff"]);
  });

  it("runs a cancel issued during a set after the set, not before it", async () => {
    const { ScheduleShutdownStatus, setScheduledShutdown, hasManagedScheduledShutdown } =
      await loadModule();

    hoisted.gateSchedule = true;
    const set = setScheduledShutdown(new Date(Date.now() + 60_000));
    await waitFor(() => hoisted.release !== null);
    // The cancel arrives while the set is still on the bus.
    const cancel = setScheduledShutdown();
    hoisted.release!();

    await expect(set).resolves.toBe(ScheduleShutdownStatus.Ok);
    await expect(cancel).resolves.toBe(ScheduleShutdownStatus.Ok);
    expect(hoisted.calls).toEqual([
      "CanPowerOff",
      "ScheduleShutdown",
      "CanPowerOff",
      "CancelScheduledShutdown",
    ]);
    expect(hasManagedScheduledShutdown()).toBe(false);
  });
});

describe("shutdown task", () => {
  it("cancels the schedule this app owns on a normal quit", async () => {
    const { setScheduledShutdown, hasManagedScheduledShutdown } = await loadModule();
    await setScheduledShutdown(new Date(Date.now() + 60_000));

    await task().run();

    expect(hoisted.calls).toContain("CancelScheduledShutdown");
    expect(hasManagedScheduledShutdown()).toBe(false);
  });

  it("keeps the schedule when the countdown itself triggers the quit", async () => {
    const { setScheduledShutdown, keepScheduledShutdownOnExit, hasManagedScheduledShutdown } =
      await loadModule();
    await setScheduledShutdown(new Date(Date.now() + 60_000));

    keepScheduledShutdownOnExit();
    await task().run();

    expect(hoisted.calls).not.toContain("CancelScheduledShutdown");
    expect(hasManagedScheduledShutdown()).toBe(true);
  });
});

describe("setScheduledShutdown (win32)", () => {
  it("arms the countdown after checking the machine can be powered off", async () => {
    useWindows();
    const { ScheduleShutdownStatus, setScheduledShutdown, hasManagedScheduledShutdown } =
      await loadModule();

    await expect(setScheduledShutdown(new Date(Date.now() + HOUR))).resolves.toBe(
      ScheduleShutdownStatus.Ok
    );
    expect(hoisted.win32Calls).toEqual(["canShutdown"]);
    expect(hasManagedScheduledShutdown()).toBe(true);
  });

  it("reports a machine that cannot be powered off before the deadline", async () => {
    useWindows();
    hoisted.canShutdown = false;
    const { ScheduleShutdownStatus, setScheduledShutdown, hasManagedScheduledShutdown } =
      await loadModule();

    await expect(setScheduledShutdown(new Date(Date.now() + HOUR))).resolves.toBe(
      ScheduleShutdownStatus.NotAvailable
    );
    expect(hasManagedScheduledShutdown()).toBe(false);
  });

  it("reports failure when the privilege cannot be checked", async () => {
    useWindows();
    hoisted.canShutdownError = true;
    const { ScheduleShutdownStatus, setScheduledShutdown, hasManagedScheduledShutdown } =
      await loadModule();

    await expect(setScheduledShutdown(new Date(Date.now() + HOUR))).resolves.toBe(
      ScheduleShutdownStatus.Failed
    );
    expect(hasManagedScheduledShutdown()).toBe(false);
  });

  it("reports the platform as unavailable when the module cannot be loaded", async () => {
    useWindows();
    hoisted.failSystemModule = true;
    const { ScheduleShutdownStatus, setScheduledShutdown } = await loadModule();

    await expect(setScheduledShutdown(new Date(Date.now() + HOUR))).resolves.toBe(
      ScheduleShutdownStatus.NotAvailable
    );
  });

  it("treats a cancel with no countdown of ours as already satisfied", async () => {
    useWindows();
    const { ScheduleShutdownStatus, setScheduledShutdown } = await loadModule();

    await expect(setScheduledShutdown()).resolves.toBe(ScheduleShutdownStatus.AlreadySet);
    // Nothing is registered with Windows, so a cancel needs no native call.
    expect(hoisted.win32Calls).toEqual([]);
  });

  it("cancels without asking the system for anything", async () => {
    useWindows();
    const { ScheduleShutdownStatus, setScheduledShutdown, hasManagedScheduledShutdown } =
      await loadModule();

    await setScheduledShutdown(new Date(Date.now() + HOUR));
    await expect(setScheduledShutdown()).resolves.toBe(ScheduleShutdownStatus.Ok);

    expect(hoisted.win32Calls).toEqual(["canShutdown"]);
    expect(hasManagedScheduledShutdown()).toBe(false);
  });

  it("treats a repeated request for the same time as already satisfied", async () => {
    useWindows();
    const { ScheduleShutdownStatus, setScheduledShutdown } = await loadModule();
    const time = new Date(Date.now() + HOUR);

    await setScheduledShutdown(time);
    await expect(setScheduledShutdown(time)).resolves.toBe(ScheduleShutdownStatus.AlreadySet);

    expect(hoisted.win32Calls).toEqual(["canShutdown"]);
  });
});

describe("exit path (win32)", () => {
  it("powers the machine off from the finalizer when the countdown completed", async () => {
    useWindows();
    const { setScheduledShutdown, keepScheduledShutdownOnExit, setPowerOffFailureHandler } =
      await loadModule();
    const refused = vi.fn();
    setPowerOffFailureHandler(refused);
    await setScheduledShutdown(new Date(Date.now() + 60_000));

    keepScheduledShutdownOnExit();
    await task().run();
    await finalizer().run();

    expect(hoisted.win32Calls).toEqual(["canShutdown", "shutdownNow"]);
    expect(hoisted.shutdownNowArgs).toEqual(["Open Orpheus 定时关机", true]);
    expect(refused).not.toHaveBeenCalled();
  });

  it("keeps the machine on when the quit was not the countdown's", async () => {
    useWindows();
    const { setScheduledShutdown, hasManagedScheduledShutdown } = await loadModule();
    await setScheduledShutdown(new Date(Date.now() + 60_000));

    await task().run();
    await finalizer().run();

    expect(hoisted.win32Calls).not.toContain("shutdownNow");
    expect(hasManagedScheduledShutdown()).toBe(false);
  });

  it("reports the refusal when the power-off is refused", async () => {
    useWindows();
    hoisted.shutdownNowError = true;
    const { setScheduledShutdown, keepScheduledShutdownOnExit, setPowerOffFailureHandler } =
      await loadModule();
    const refused = vi.fn();
    setPowerOffFailureHandler(refused);
    await setScheduledShutdown(new Date(Date.now() + 60_000));

    keepScheduledShutdownOnExit();
    await task().run();

    await expect(finalizer().run()).resolves.toBeUndefined();
    expect(hoisted.win32Calls).toEqual(["canShutdown", "shutdownNow"]);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("drops the countdown when re-arming it is refused", async () => {
    useWindows();
    const {
      ScheduleShutdownStatus,
      setScheduledShutdown,
      hasManagedScheduledShutdown,
      keepScheduledShutdownOnExit,
    } = await loadModule();
    await setScheduledShutdown(new Date(Date.now() + HOUR));
    expect(hasManagedScheduledShutdown()).toBe(true);

    // Changing the time is checked again, and this time the machine refuses.
    hoisted.canShutdown = false;
    await expect(setScheduledShutdown(new Date(Date.now() + 2 * HOUR))).resolves.toBe(
      ScheduleShutdownStatus.NotAvailable
    );

    // The caller tells the user that the new time will not take effect, so this
    // app must not power the machine off at it either.
    expect(hasManagedScheduledShutdown()).toBe(false);
    keepScheduledShutdownOnExit();
    await task().run();
    await finalizer().run();
    expect(hoisted.win32Calls).not.toContain("shutdownNow");
  });
});

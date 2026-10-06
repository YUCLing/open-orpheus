import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import { installLoggerStub } from "../helpers/globals";

const hoisted = vi.hoisted(() => ({
  app: {
    on: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    isReady: vi.fn(() => true),
  },
  flushLogs: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  app: hoisted.app,
}));

installLoggerStub();

import {
  currentState,
  events,
  LifecycleState,
  setLifecycleState,
  setStartupTask,
  startupTask,
} from "@main/services/lifecycle";

// The state is module-owned and always live, so there is nothing to install.
// Reset it explicitly: this group reads the statically imported module, whose
// state persists between tests in the same file.
beforeEach(() => {
  vi.clearAllMocks();
  setLifecycleState(LifecycleState.Starting);
});

describe("startupTask", () => {
  // `startupTask` is module state that is only ever set once, so the first test
  // is the one that observes the untouched module.
  it("starts unset", () => {
    expect(startupTask).toBeNull();
  });

  it("records an opened local file", () => {
    setStartupTask({ type: "openFile", file: "/music/song.mp3" });

    expect(startupTask).toEqual({ type: "openFile", file: "/music/song.mp3" });
  });

  it("ignores a second task", () => {
    setStartupTask({ type: "openUrl", url: "orpheus://song/1" });

    // The first task wins and is not overwritten by a later one.
    expect(startupTask).toEqual({ type: "openFile", file: "/music/song.mp3" });
  });
});

describe("setLifecycleState", () => {
  it("tracks the current state", () => {
    setLifecycleState(LifecycleState.MainWindowCreated, {} as never);
    expect(currentState()).toBe(LifecycleState.MainWindowCreated);

    setLifecycleState(LifecycleState.MainWindowLoaded, {} as never);
    expect(currentState()).toBe(LifecycleState.MainWindowLoaded);
  });

  it("emits the event matching the state", async () => {
    const onStarted = vi.fn();
    events.on("started", onStarted);

    const emitted = new Promise<void>((resolve) => {
      void events.once("started").then(() => resolve());
    });

    setLifecycleState(LifecycleState.Started);
    await emitted;

    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("emits the quitting event with no payload", async () => {
    const onQuitting = vi.fn();
    events.on("quitting", onQuitting);

    const emitted = new Promise<void>((resolve) => {
      void events.once("quitting").then(() => resolve());
    });

    setLifecycleState(LifecycleState.Quitting);
    await emitted;

    expect(onQuitting).toHaveBeenCalledTimes(1);
    expect(currentState()).toBe(LifecycleState.Quitting);
  });

  it("does not emit for states without an event", () => {
    const onStarted = vi.fn();
    events.on("started", onStarted);

    setLifecycleState(LifecycleState.Starting);

    expect(currentState()).toBe(LifecycleState.Starting);
    expect(onStarted).not.toHaveBeenCalled();
  });
});

// --- Shutdown -------------------------------------------------------------
//
// Every test below needs its own module instance: `installLifecycle` is
// idempotent and `registerShutdownTask` accumulates, so sharing one instance
// across tests would leak tasks and handlers between them.
//
// The bounds are configured small. `AbortSignal.timeout` runs on an internal
// timer that `vi.useFakeTimers()` cannot advance, so these are real waits.

type AppEventHandler = (...args: unknown[]) => void;

let prependListenerSpy: MockInstance;
let signalHandlers: Map<string, AppEventHandler>;

async function freshLifecycle(
  options?: Parameters<typeof import("@main/services/lifecycle").installLifecycle>[0]
) {
  vi.resetModules();
  signalHandlers.clear();
  hoisted.app.on.mockClear();
  hoisted.app.quit.mockClear();
  hoisted.app.exit.mockClear();
  hoisted.app.isReady.mockReturnValue(true);

  const lifecycle = await import("@main/services/lifecycle");
  lifecycle.installLifecycle({ flushLogs: hoisted.flushLogs, ...options });
  return lifecycle;
}

function appEventHandlers(name: string): AppEventHandler[] {
  return hoisted.app.on.mock.calls
    .filter((call) => call[0] === name)
    .map((call) => call[1] as AppEventHandler);
}

function lastAppHandler(name: string): AppEventHandler {
  const handler = appEventHandlers(name).at(-1);
  if (!handler) throw new Error(`No handler registered for ${name}`);
  return handler;
}

/** Drive a quit the way Electron does, and wait for the sequence to finish. */
async function quit(): Promise<void> {
  lastAppHandler("before-quit")({ preventDefault: vi.fn() });
  await vi.waitFor(() => expect(hoisted.app.quit).toHaveBeenCalled());
}

function fireSignal(signal: string): void {
  const handler = signalHandlers.get(signal);
  if (!handler) throw new Error(`${signal} handler was not registered`);
  handler(signal);
}

beforeEach(() => {
  signalHandlers = new Map();
  // Capture instead of registering: the test process must not end up with the
  // app's real signal handlers attached.
  prependListenerSpy = vi
    .spyOn(process, "prependListener")
    .mockImplementation((event, listener) => {
      signalHandlers.set(String(event), listener as AppEventHandler);
      return process;
    });
});

afterEach(() => {
  prependListenerSpy.mockRestore();
});

describe("shutdown tasks", () => {
  it("runs tasks in reverse registration order", async () => {
    const order: string[] = [];
    const lifecycle = await freshLifecycle();

    for (const name of ["a", "b", "c"]) {
      lifecycle.registerShutdownTask({
        name,
        run: () => {
          order.push(name);
        },
      });
    }

    await quit();

    expect(order).toEqual(["c", "b", "a"]);
  });

  it("runs the remaining tasks when one throws", async () => {
    const order: string[] = [];
    const lifecycle = await freshLifecycle();

    lifecycle.registerShutdownTask({
      name: "first",
      run: () => {
        order.push("first");
      },
    });
    lifecycle.registerShutdownTask({
      name: "boom",
      run: () => {
        throw new Error("boom");
      },
    });
    lifecycle.registerShutdownTask({
      name: "last",
      run: () => {
        order.push("last");
      },
    });

    await quit();

    // LIFO: last, boom, first.
    expect(order).toEqual(["last", "first"]);
  });

  it("abandons a hung task at its own timeout and still runs the next one", async () => {
    const ran: string[] = [];
    const lifecycle = await freshLifecycle();

    // Registered first, so LIFO runs it last.
    lifecycle.registerShutdownTask({
      name: "after",
      run: () => {
        ran.push("after");
      },
    });
    lifecycle.registerShutdownTask({
      name: "hung",
      timeoutMs: 20,
      run: () => new Promise<void>(() => {}),
    });

    const startedAt = Date.now();
    await quit();

    expect(ran).toEqual(["after"]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  it("gives the next task a signal that the previous timeout did not abort", async () => {
    let hungSignal: AbortSignal | undefined;
    let nextAborted: boolean | undefined;
    const lifecycle = await freshLifecycle();

    lifecycle.registerShutdownTask({
      name: "next",
      run: (signal) => {
        nextAborted = signal.aborted;
      },
    });
    lifecycle.registerShutdownTask({
      name: "hung",
      timeoutMs: 20,
      run: (signal) => {
        hungSignal = signal;
        return new Promise<void>(() => {});
      },
    });

    await quit();

    expect(hungSignal?.aborted).toBe(true);
    expect(nextAborted).toBe(false);
  });

  it("stops starting tasks once the overall deadline is reached", async () => {
    const ran: string[] = [];
    const lifecycle = await freshLifecycle({
      shutdownDeadlineMs: 60,
      taskTimeoutMs: 1000,
    });

    lifecycle.registerShutdownTask({
      name: "third",
      run: () => {
        ran.push("third");
      },
    });
    lifecycle.registerShutdownTask({
      name: "second",
      run: () => {
        ran.push("second");
      },
    });
    // Registered last, so it runs first and never settles. Its own timeout is
    // far larger than the deadline, so the deadline is what ends it.
    lifecycle.registerShutdownTask({
      name: "hung",
      run: () => new Promise<void>(() => {}),
    });

    await quit();

    expect(ran).toEqual([]);
  });

  it("does not leave a straggler rejection unhandled", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      const lifecycle = await freshLifecycle({ taskTimeoutMs: 20 });
      lifecycle.registerShutdownTask({
        name: "late",
        run: () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error("late")), 40);
          }),
      });

      await quit();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("marks the app as quitting before the first task runs", async () => {
    const states: number[] = [];
    const lifecycle = await freshLifecycle();

    lifecycle.registerShutdownTask({
      name: "observer",
      run: () => {
        states.push(lifecycle.currentState());
      },
    });

    await quit();

    expect(states).toEqual([LifecycleState.Quitting]);
  });

  it("flushes logs last", async () => {
    const order: string[] = [];
    const lifecycle = await freshLifecycle();
    hoisted.flushLogs.mockImplementation(() => {
      order.push("flush");
    });

    lifecycle.registerShutdownTask({
      name: "task",
      run: () => {
        order.push("task");
      },
    });

    await quit();

    expect(order).toEqual(["task", "flush"]);
  });
});

// Finalizers exist because a task can be skipped once the deadline is reached,
// and some work is the point of the shutdown rather than cleanup: skipping it
// silently leaves the user's request unfulfilled.
describe("shutdown finalizers", () => {
  it.each(["SIGINT", "SIGTERM"])("runs callback finalization before %s exits", async (signal) => {
    const lifecycle = await freshLifecycle();
    const order: string[] = [];
    lifecycle.registerShutdownTask({
      name: "dispose",
      run: () => {
        order.push("dispose");
      },
    });
    lifecycle.registerShutdownFinalizer({
      name: "window-callbacks",
      run: () => {
        order.push("reap");
      },
    });
    hoisted.app.exit.mockImplementation(() => {
      order.push("exit");
    });
    fireSignal(signal);
    await vi.waitFor(() => expect(hoisted.app.exit).toHaveBeenCalled());
    expect(order).toEqual(["dispose", "reap", "exit"]);
  });

  it("runs finalizers even when the deadline skipped the tasks", async () => {
    const ran: string[] = [];
    const lifecycle = await freshLifecycle({
      shutdownDeadlineMs: 60,
      taskTimeoutMs: 1000,
    });

    // Registered first, so it is the last task to run — and never gets to.
    lifecycle.registerShutdownTask({
      name: "skipped",
      run: () => {
        ran.push("skipped");
      },
    });
    // Registered last, so it runs first and takes the deadline with it.
    lifecycle.registerShutdownTask({
      name: "hung",
      run: () => new Promise<void>(() => {}),
    });
    lifecycle.registerShutdownFinalizer({
      name: "power-off",
      run: () => {
        ran.push("power-off");
      },
    });

    await quit();

    expect(ran).toEqual(["power-off"]);
  });

  it("runs finalizers after the log flush", async () => {
    const order: string[] = [];
    const lifecycle = await freshLifecycle();
    hoisted.flushLogs.mockImplementation(() => {
      order.push("flush");
    });

    lifecycle.registerShutdownTask({
      name: "task",
      run: () => {
        order.push("task");
      },
    });
    lifecycle.registerShutdownFinalizer({
      name: "power-off",
      run: () => {
        order.push("power-off");
      },
    });

    await quit();

    expect(order).toEqual(["task", "flush", "power-off"]);
  });

  it("keeps running the other finalizers when one fails", async () => {
    const ran: string[] = [];
    const lifecycle = await freshLifecycle();

    // LIFO: `boom` runs first, `after` still gets its turn.
    lifecycle.registerShutdownFinalizer({
      name: "after",
      run: () => {
        ran.push("after");
      },
    });
    lifecycle.registerShutdownFinalizer({
      name: "boom",
      run: () => {
        throw new Error("boom");
      },
    });

    await quit();

    expect(ran).toEqual(["after"]);
  });

  it("abandons a hung finalizer at its own timeout", async () => {
    const ran: string[] = [];
    const lifecycle = await freshLifecycle({ finalizerTimeoutMs: 20 });

    // LIFO: `hung` runs first.
    lifecycle.registerShutdownFinalizer({
      name: "after",
      run: () => {
        ran.push("after");
      },
    });
    lifecycle.registerShutdownFinalizer({
      name: "hung",
      run: () => new Promise<void>(() => {}),
    });

    const startedAt = Date.now();
    await quit();

    expect(ran).toEqual(["after"]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });
});

describe("installLifecycle", () => {
  it("is idempotent", async () => {
    const lifecycle = await freshLifecycle();
    lifecycle.installLifecycle();

    expect(appEventHandlers("before-quit")).toHaveLength(1);
    expect(appEventHandlers("window-all-closed")).toHaveLength(1);
  });

  it("holds the quit back while shutting down, then lets it through", async () => {
    const lifecycle = await freshLifecycle();
    lifecycle.registerShutdownTask({ name: "noop", run: () => {} });
    const onBeforeQuit = lastAppHandler("before-quit");

    const firstPass = vi.fn();
    onBeforeQuit({ preventDefault: firstPass });
    await vi.waitFor(() => expect(hoisted.app.quit).toHaveBeenCalled());
    expect(firstPass).toHaveBeenCalledTimes(1);

    // The pass Electron makes after the tasks have run must not be held back.
    const secondPass = vi.fn();
    onBeforeQuit({ preventDefault: secondPass });
    expect(secondPass).not.toHaveBeenCalled();
  });

  it("quits on window-all-closed unless still starting", async () => {
    const lifecycle = await freshLifecycle();
    const onWindowAllClosed = lastAppHandler("window-all-closed");

    onWindowAllClosed();
    expect(hoisted.app.quit).not.toHaveBeenCalled();

    lifecycle.setLifecycleState(LifecycleState.Started);
    onWindowAllClosed();
    expect(hoisted.app.quit).toHaveBeenCalledTimes(1);
  });
});

describe("signals", () => {
  it("runs the tasks on SIGTERM and then exits 143", async () => {
    const ran: string[] = [];
    const lifecycle = await freshLifecycle();
    lifecycle.registerShutdownTask({
      name: "task",
      run: () => {
        ran.push("task");
      },
    });

    fireSignal("SIGTERM");

    await vi.waitFor(() => expect(hoisted.app.exit).toHaveBeenCalledWith(143));
    expect(ran).toEqual(["task"]);
  });

  it("exits 130 on SIGINT", async () => {
    await freshLifecycle();

    fireSignal("SIGINT");

    await vi.waitFor(() => expect(hoisted.app.exit).toHaveBeenCalledWith(130));
  });

  it("exits immediately on a second signal without re-running tasks", async () => {
    const ran: string[] = [];
    const lifecycle = await freshLifecycle();
    lifecycle.registerShutdownTask({
      name: "slow",
      timeoutMs: 500,
      run: () => {
        ran.push("slow");
        return new Promise<void>(() => {});
      },
    });

    fireSignal("SIGTERM");
    fireSignal("SIGTERM");

    expect(hoisted.app.exit).toHaveBeenCalledWith(143);
    // Started once, and not restarted by the second signal.
    expect(ran).toEqual(["slow"]);
  });

  it("falls back to process.exit before the app is ready", async () => {
    await freshLifecycle();
    hoisted.app.isReady.mockReturnValue(false);
    const processExit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    try {
      fireSignal("SIGTERM");

      await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(143));
      expect(hoisted.app.exit).not.toHaveBeenCalled();
    } finally {
      processExit.mockRestore();
    }
  });
});

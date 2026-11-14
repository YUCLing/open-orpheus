import { describe, expect, it, vi } from "vitest";

import {
  LifecyclePhase,
  LifecycleTimeoutError,
  RealmLifecycle,
} from "../../../src/shared/plugin/lifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("RealmLifecycle", () => {
  it("activates and deactivates", async () => {
    const deactivate = vi.fn();
    const lifecycle = new RealmLifecycle({
      adapter: {
        load: async () => "module",
        activate: vi.fn(),
        deactivate,
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.phase === LifecyclePhase.Active);
    expect(lifecycle.snapshot.module).toBe("module");

    lifecycle.disable();
    await lifecycle.waitFor((snapshot) => snapshot.phase === LifecyclePhase.Disabled);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it("rolls back a timed-out activation and requires retry", async () => {
    const gate = deferred();
    const deactivate = vi.fn();
    const lifecycle = new RealmLifecycle({
      timeoutMs: 10,
      adapter: {
        load: async () => "module",
        activate: async () => {
          await gate.promise;
        },
        deactivate,
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.timedOut);
    expect(lifecycle.snapshot.error).toBeInstanceOf(LifecycleTimeoutError);
    expect(lifecycle.snapshot.retryRequired).toBe(true);

    gate.resolve();
    await lifecycle.waitFor(
      (snapshot) => snapshot.phase === LifecyclePhase.Failed && snapshot.cleanupPending === false
    );

    expect(deactivate).toHaveBeenCalled();
    expect(lifecycle.snapshot.module).toBeUndefined();
    expect(lifecycle.snapshot.retryRequired).toBe(true);
  });

  it("cleans up when disabled during activation", async () => {
    const gate = deferred();
    const deactivate = vi.fn();
    const lifecycle = new RealmLifecycle({
      timeoutMs: 1000,
      adapter: {
        load: async () => "module",
        activate: async () => {
          await gate.promise;
        },
        deactivate,
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.phase === LifecyclePhase.Enabling);
    lifecycle.disable();
    gate.resolve();

    await lifecycle.waitFor((snapshot) => snapshot.phase === LifecyclePhase.Disabled);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed activation", async () => {
    let attempts = 0;
    const deactivate = vi.fn();
    const lifecycle = new RealmLifecycle({
      adapter: {
        load: async () => "module",
        activate: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("boom");
        },
        deactivate,
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor(
      (snapshot) => snapshot.phase === LifecyclePhase.Failed && snapshot.cleanupPending === false
    );
    expect(lifecycle.snapshot.retryRequired).toBe(true);

    lifecycle.retry();
    await lifecycle.waitFor((snapshot) => snapshot.phase === LifecyclePhase.Active);
    expect(attempts).toBe(2);
  });

  it("retains a module when cleanup fails and retries cleanup on enable", async () => {
    const deactivate = vi
      .fn()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValueOnce(undefined);
    const lifecycle = new RealmLifecycle({
      adapter: {
        load: async () => "module",
        activate: vi.fn(),
        deactivate,
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.phase === LifecyclePhase.Active);
    lifecycle.disable();
    await lifecycle.waitFor(
      (snapshot) => snapshot.phase === LifecyclePhase.Failed && snapshot.cleanupPending === true
    );
    expect(lifecycle.snapshot.module).toBe("module");

    lifecycle.enable();
    lifecycle.retry();
    await lifecycle.waitFor((snapshot) => snapshot.phase === LifecyclePhase.Active);
    expect(deactivate).toHaveBeenCalledTimes(2);
  });

  it("does not auto-retry a timed-out activation that produced no module", async () => {
    const gate = deferred();
    let attempts = 0;
    const lifecycle = new RealmLifecycle({
      timeoutMs: 10,
      adapter: {
        load: async () => {
          attempts += 1;
          await gate.promise;
          throw new Error("late load failure");
        },
        activate: vi.fn(),
        deactivate: vi.fn(),
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.timedOut);
    gate.resolve();
    await lifecycle.waitFor(
      (snapshot) => snapshot.phase === LifecyclePhase.Failed && snapshot.cleanupPending === false
    );

    expect(attempts).toBe(1);
    expect(lifecycle.snapshot.retryRequired).toBe(true);
  });

  it("resolves dispose when deactivate throws synchronously", async () => {
    const lifecycle = new RealmLifecycle({
      adapter: {
        load: async () => "module",
        activate: vi.fn(),
        deactivate: () => {
          throw new Error("sync cleanup failure");
        },
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.phase === LifecyclePhase.Active);

    await expect(lifecycle.dispose(10)).resolves.toBeUndefined();
    expect(lifecycle.snapshot.cleanupPending).toBe(true);
  });

  it("does not deactivate twice when disposed during cleanup", async () => {
    const gate = deferred();
    const deactivate = vi.fn(async () => {
      await gate.promise;
    });
    const lifecycle = new RealmLifecycle({
      timeoutMs: 1000,
      adapter: {
        load: async () => "module",
        activate: vi.fn(),
        deactivate,
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.phase === LifecyclePhase.Active);
    lifecycle.disable();
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));

    const disposing = lifecycle.dispose(1000);
    gate.resolve();
    await disposing;

    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it("allows disabling a plugin whose timed-out activation never settles", async () => {
    const never = new Promise<void>(() => {});
    const deactivate = vi.fn();
    const lifecycle = new RealmLifecycle({
      timeoutMs: 10,
      adapter: {
        load: async () => "module",
        activate: async () => {
          await never;
        },
        deactivate,
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.timedOut);
    lifecycle.disable();
    await lifecycle.waitFor((snapshot) => snapshot.phase === LifecyclePhase.Disabled);

    expect(deactivate).toHaveBeenCalled();
  });
});

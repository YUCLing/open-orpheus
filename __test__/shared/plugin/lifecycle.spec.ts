import { describe, expect, it, vi } from "vitest";

import {
  LifecycleFailureStage,
  LifecycleStateKind,
  LifecycleTimeoutError,
  PluginDisposeStatus,
  RealmLifecycle,
  type LifecycleSnapshot,
} from "../../../src/shared/plugin/lifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function kind(snapshot: LifecycleSnapshot<unknown>): LifecycleStateKind {
  return snapshot.state.kind;
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
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Running);
    expect(lifecycle.snapshot.module).toBe("module");

    lifecycle.disable();
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Stopped);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it("reports a timed-out activation as hung without starting cleanup", async () => {
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
    const hung = await lifecycle.waitFor(
      (snapshot) => snapshot.state.kind === LifecycleStateKind.Hung
    );
    expect(hung.error).toBeInstanceOf(LifecycleTimeoutError);
    // activate() is still running; cleanup must not overlap it.
    expect(deactivate).not.toHaveBeenCalled();

    lifecycle.disable();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lifecycle.snapshot.state.kind).toBe(LifecycleStateKind.Hung);
    expect(deactivate).not.toHaveBeenCalled();
  });

  it("cleans up a timed-out activation once it settles and is disabled", async () => {
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
    await lifecycle.waitFor((snapshot) => snapshot.state.kind === LifecycleStateKind.Hung);
    lifecycle.disable();
    gate.resolve();

    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Stopped);
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot.module).toBeUndefined();
  });

  it("becomes running when a timed-out activation eventually succeeds", async () => {
    const gate = deferred();
    const lifecycle = new RealmLifecycle({
      timeoutMs: 10,
      adapter: {
        load: async () => "module",
        activate: async () => {
          await gate.promise;
        },
        deactivate: vi.fn(),
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.state.kind === LifecycleStateKind.Hung);
    gate.resolve();

    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Running);
  });

  it("waits for an in-flight activation before cleaning up on disable", async () => {
    const gate = deferred();
    const calls: string[] = [];
    const lifecycle = new RealmLifecycle({
      timeoutMs: 1000,
      adapter: {
        load: async () => "module",
        activate: async () => {
          calls.push("activate:start");
          await gate.promise;
          calls.push("activate:end");
        },
        deactivate: () => {
          calls.push("deactivate");
        },
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.state.kind === LifecycleStateKind.Starting);
    lifecycle.disable();
    gate.resolve();

    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Stopped);
    expect(calls).toEqual(["activate:start", "activate:end", "deactivate"]);
  });

  it("requires explicit retry after a failed activation", async () => {
    let attempts = 0;
    const lifecycle = new RealmLifecycle({
      adapter: {
        load: async () => "module",
        activate: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("boom");
        },
        deactivate: vi.fn(),
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor(
      (snapshot) =>
        snapshot.state.kind === LifecycleStateKind.Failed &&
        snapshot.state.stage === LifecycleFailureStage.Activate
    );
    expect(attempts).toBe(1);

    // Enabling again is idempotent and does not retry.
    lifecycle.enable();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(1);

    lifecycle.retry();
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Running);
    expect(attempts).toBe(2);
  });

  it("cleans a partially activated module after activation throws", async () => {
    const deactivate = vi.fn();
    const lifecycle = new RealmLifecycle({
      adapter: {
        load: async () => "module",
        activate: async () => {
          throw new Error("boom");
        },
        deactivate,
      },
    });

    lifecycle.enable();
    const failed = await lifecycle.waitFor(
      (snapshot) =>
        snapshot.state.kind === LifecycleStateKind.Failed &&
        snapshot.state.stage === LifecycleFailureStage.Activate
    );

    expect(failed.error).toBeInstanceOf(Error);
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot.module).toBeUndefined();
  });

  it("retains a module when cleanup fails and cleans it on retry", async () => {
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
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Running);

    lifecycle.disable();
    const failed = await lifecycle.waitFor(
      (snapshot) =>
        snapshot.state.kind === LifecycleStateKind.Failed &&
        snapshot.state.stage === LifecycleFailureStage.Deactivate
    );
    expect(failed.module).toBe("module");

    lifecycle.enable();
    lifecycle.retry();
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Running);
    expect(deactivate).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed cleanup visible while disabled", async () => {
    const deactivate = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    const lifecycle = new RealmLifecycle({
      adapter: {
        load: async () => "module",
        activate: vi.fn(),
        deactivate,
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Running);
    lifecycle.disable();

    await lifecycle.waitFor(
      (snapshot) =>
        snapshot.state.kind === LifecycleStateKind.Failed &&
        snapshot.state.stage === LifecycleFailureStage.Deactivate
    );
    // No hot retry loop: cleanup failure is terminal until the next command.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot.module).toBe("module");
  });

  it("reports cleanup timeout as hung and never claims stopped", async () => {
    const gate = deferred();
    const lifecycle = new RealmLifecycle({
      timeoutMs: 10,
      adapter: {
        load: async () => "module",
        activate: vi.fn(),
        deactivate: async () => {
          await gate.promise;
        },
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Running);
    lifecycle.disable();

    const hung = await lifecycle.waitFor(
      (snapshot) =>
        snapshot.state.kind === LifecycleStateKind.Hung &&
        snapshot.state.stage === LifecycleFailureStage.Deactivate
    );
    expect(hung.error).toBeInstanceOf(LifecycleTimeoutError);
    expect(lifecycle.snapshot.module).toBe("module");
  });

  it("finishes a timed-out cleanup when deactivate eventually settles", async () => {
    const gate = deferred();
    const lifecycle = new RealmLifecycle({
      timeoutMs: 10,
      adapter: {
        load: async () => "module",
        activate: vi.fn(),
        deactivate: async () => {
          await gate.promise;
        },
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Running);
    lifecycle.disable();
    await lifecycle.waitFor(
      (snapshot) =>
        snapshot.state.kind === LifecycleStateKind.Hung &&
        snapshot.state.stage === LifecycleFailureStage.Deactivate
    );
    expect(lifecycle.snapshot.module).toBe("module");

    gate.resolve();
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Stopped);
    expect(lifecycle.snapshot.module).toBeUndefined();
  });

  it("waits for cleanup when activation fails during disposal", async () => {
    const gate = deferred();
    const deactivate = vi.fn(async () => {});
    const lifecycle = new RealmLifecycle({
      timeoutMs: 1000,
      adapter: {
        load: async () => "module",
        activate: async () => {
          await gate.promise;
          throw new Error("activation failed");
        },
        deactivate,
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Starting);

    const disposing = lifecycle.dispose(1000);
    gate.resolve();

    await expect(disposing).resolves.toEqual({ status: PluginDisposeStatus.Stopped });
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it("does not call deactivate twice when disposed during cleanup", async () => {
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
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Running);
    lifecycle.disable();
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));

    const disposing = lifecycle.dispose(1000);
    gate.resolve();
    await disposing;

    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it("abandons work that outlives the dispose deadline", async () => {
    const never = new Promise<void>(() => {});
    const lifecycle = new RealmLifecycle({
      timeoutMs: 10,
      adapter: {
        load: async () => "module",
        activate: async () => {
          await never;
        },
        deactivate: vi.fn(),
      },
    });

    lifecycle.enable();
    await lifecycle.waitFor((snapshot) => snapshot.state.kind === LifecycleStateKind.Hung);

    const result = await lifecycle.dispose(10);
    expect(result.status).toBe(PluginDisposeStatus.Abandoned);
    expect(lifecycle.snapshot.state.kind).toBe(LifecycleStateKind.Abandoned);
  });

  it("ignores desired states older than the current revision", async () => {
    const activate = vi.fn();
    const lifecycle = new RealmLifecycle({
      adapter: { load: async () => "module", activate, deactivate: vi.fn() },
    });

    lifecycle.applyDesiredState({ enabled: true, revision: 5 });
    await lifecycle.waitFor((snapshot) => kind(snapshot) === LifecycleStateKind.Running);
    lifecycle.applyDesiredState({ enabled: false, revision: 4 });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lifecycle.snapshot.desired.enabled).toBe(true);
    expect(lifecycle.snapshot.state.kind).toBe(LifecycleStateKind.Running);
  });
});

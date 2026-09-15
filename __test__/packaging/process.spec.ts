import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: hoisted.spawn }));

import { runStreaming } from "../../packaging/common/process";

/** Minimal stand-in for the `ChildProcess` `runStreaming` listens to. */
function fakeChild() {
  return new EventEmitter();
}

describe("runStreaming", () => {
  beforeEach(() => {
    hoisted.spawn.mockReset();
    hoisted.spawn.mockImplementation(() => fakeChild());
  });

  it("spawns the command with inherited stdio", async () => {
    const promise = runStreaming("tar", ["czf", "out.tar.gz"]);

    expect(hoisted.spawn).toHaveBeenCalledWith("tar", ["czf", "out.tar.gz"], {
      stdio: "inherit",
    });

    hoisted.spawn.mock.results[0].value.emit("close", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("passes cwd and env through", async () => {
    const promise = runStreaming("make", ["all"], {
      cwd: "/work",
      env: { PATH: "/usr/bin" },
    });

    expect(hoisted.spawn).toHaveBeenCalledWith("make", ["all"], {
      stdio: "inherit",
      cwd: "/work",
      env: { PATH: "/usr/bin" },
    });

    hoisted.spawn.mock.results[0].value.emit("close", 0);
    await promise;
  });

  it("stays pending until the child closes", async () => {
    const promise = runStreaming("sleep", ["1"], {});
    let settled = false;
    void promise.then(() => (settled = true)).catch(() => (settled = true));

    await Promise.resolve();
    expect(settled).toBe(false);

    hoisted.spawn.mock.results[0].value.emit("close", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects on a non-zero or null exit code", async () => {
    const failed = runStreaming("false", [], {});
    hoisted.spawn.mock.results[0].value.emit("close", 2);
    await expect(failed).rejects.toThrow("false exited with code 2");

    // A null code means the child was killed by a signal.
    const killed = runStreaming("killed", [], {});
    hoisted.spawn.mock.results[1].value.emit("close", null);
    await expect(killed).rejects.toThrow("killed exited with code null");
  });

  it("rejects when the command cannot be spawned", async () => {
    const promise = runStreaming("missing-binary", [], {});

    hoisted.spawn.mock.results[0].value.emit(
      "error",
      new Error("spawn missing-binary ENOENT")
    );

    await expect(promise).rejects.toThrow("spawn missing-binary ENOENT");
  });
});
